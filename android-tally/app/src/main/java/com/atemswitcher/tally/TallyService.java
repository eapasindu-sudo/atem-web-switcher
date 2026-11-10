package com.atemswitcher.tally;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.WindowManager;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Keeps a live connection to the ATEM Switcher's tally stream (GET /api/tally/events) and draws the
 * border over every app (DJI Fly included): red when this input is on PROGRAM, green on PREVIEW.
 */
public final class TallyService extends Service {
    static final String STOP = "stop";
    private static final String CHANNEL = "tally";

    private final Handler main = new Handler(Looper.getMainLooper());
    private WindowManager wm;
    private BorderView border;
    // each connection thread runs while it is the current one, so a restart never leaves two running
    private volatile Object current;
    private volatile HttpURLConnection conn;
    private Thread worker;

    // last tally from the switcher
    private volatile boolean connected; // to the switcher
    private volatile boolean atem;      // the switcher to the ATEM
    private volatile int program, preview;
    private volatile boolean inTransition;
    private volatile String inputName = "";

    static void start(Context c) {
        Intent i = new Intent(c, TallyService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
        else c.startService(i);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            Prefs.get(this).edit().putBoolean(Prefs.RUNNING, false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(1, notification("Connecting…"));
        if (border == null) addBorder();
        // (re)connect with the current settings
        stopWorker();
        Object token = new Object();
        current = token;
        worker = new Thread(() -> loop(token), "tally");
        worker.start();
        redraw();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopWorker();
        if (border != null) {
            try {
                wm.removeView(border);
            } catch (Exception ignored) {
            }
            border = null;
        }
        super.onDestroy();
    }

    private void stopWorker() {
        current = null;
        HttpURLConnection c = conn;
        if (c != null) c.disconnect();
        if (worker != null) worker.interrupt();
        worker = null;
    }

    private void addBorder() {
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this)) return;
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        border = new BorderView(this);
        int type = Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        if (Build.VERSION.SDK_INT >= 28) {
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        // Android 12+ only lets touches pass through another app's window when it is at most 80% opaque,
        // so the drone app keeps working under the border
        if (Build.VERSION.SDK_INT >= 31) lp.alpha = 0.8f;
        wm.addView(border, lp);
    }

    // ---- connection ----
    private void loop(Object token) {
        while (current == token) {
            String host = Prefs.get(this).getString(Prefs.HOST, Prefs.DEFAULT_HOST);
            if (host.isEmpty()) {
                sleep(1000);
                continue;
            }
            // the ATEM Switcher PC (port 3000) gives names and works through Playout; else talk to the ATEM itself
            if (host.contains(":") || switcherAnswers(host)) followSwitcher(token, host);
            else followAtem(token, host);
            if (current != token) return;
            if (connected) {
                connected = false;
                redraw();
            }
            sleep(1000);
        }
    }

    private static boolean switcherAnswers(String host) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(Prefs.baseUrl(host) + "/api/tally").openConnection();
            c.setConnectTimeout(1500);
            c.setReadTimeout(1500);
            boolean ok = c.getResponseCode() == 200;
            c.disconnect();
            return ok;
        } catch (Exception e) {
            return false;
        }
    }

    private void followSwitcher(Object token, String host) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(Prefs.baseUrl(host) + "/api/tally/events").openConnection();
            conn = c;
            c.setConnectTimeout(3000);
            c.setReadTimeout(12000); // the switcher sends a ping every 5 s
            c.setRequestProperty("Accept", "text/event-stream");
            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
            String line;
            while (current == token && (line = r.readLine()) != null) {
                if (!line.startsWith("data:")) continue;
                onTally(new JSONObject(line.substring(5).trim()));
            }
        } catch (Exception ignored) {
        } finally {
            HttpURLConnection c = conn;
            if (c != null) c.disconnect();
            conn = null;
        }
    }

    private void followAtem(Object token, String host) {
        new AtemClient(host, (ok, pgm, pvw, trans, names) -> {
            if (current != token) return;
            try {
                JSONObject t = new JSONObject();
                t.put("connected", ok);
                t.put("program", pgm);
                t.put("preview", pvw);
                t.put("inTransition", trans);
                org.json.JSONArray sources = new org.json.JSONArray();
                for (Map.Entry<Integer, String> e : names.entrySet()) {
                    sources.put(new JSONObject().put("id", e.getKey()).put("label", e.getValue()));
                }
                t.put("sources", sources);
                if (ok) onTally(t);
                else if (connected) {
                    connected = false;
                    redraw();
                }
            } catch (Exception ignored) {
            }
        }).connectOnce(() -> current == token);
    }

    private void onTally(JSONObject t) {
        connected = true;
        atem = t.optBoolean("connected");
        program = t.optInt("program", -1);
        preview = t.optInt("preview", -1);
        inTransition = t.optBoolean("inTransition");
        int input = Prefs.get(this).getInt(Prefs.INPUT, 1);
        String name = "IN " + input;
        org.json.JSONArray sources = t.optJSONArray("sources");
        if (sources != null) {
            for (int i = 0; i < sources.length(); i++) {
                JSONObject s = sources.optJSONObject(i);
                if (s != null && s.optInt("id") == input) name = s.optString("label", name);
            }
        }
        inputName = name;
        // the settings screen lists the inputs by these names
        if (sources != null && sources.length() > 0) {
            String json = sources.toString();
            if (!json.equals(Prefs.get(this).getString(Prefs.SOURCES, ""))) Prefs.get(this).edit().putString(Prefs.SOURCES, json).apply();
        }
        redraw();
    }

    private void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
        }
    }

    // ---- drawing ----
    private void redraw() {
        main.post(() -> {
            SharedPreferences p = Prefs.get(this);
            int input = p.getInt(Prefs.INPUT, 1);
            boolean onAir = connected && atem && (program == input || (inTransition && preview == input));
            boolean onPreview = connected && atem && !onAir && preview == input && p.getBoolean(Prefs.PREVIEW, true);
            int color = onAir ? BorderView.RED : onPreview ? BorderView.GREEN : 0;
            String label = !p.getBoolean(Prefs.LABEL, false) || color == 0 ? null : onAir ? "ON AIR" : "PREVIEW";
            float density = getResources().getDisplayMetrics().density;
            int width = Math.round(p.getInt(Prefs.WIDTH, 6) * density);
            if (border != null) border.show(color, width, label, !connected || !atem);
            String status = !connected ? "Looking for the ATEM at " + p.getString(Prefs.HOST, Prefs.DEFAULT_HOST)
                    : !atem ? "ATEM Switcher has no ATEM connected"
                    : inputName + (onAir ? ": ON AIR" : onPreview ? ": PREVIEW" : ": not on air");
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.notify(1, notification(status));
        });
    }

    private Notification notification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            if (nm.getNotificationChannel(CHANNEL) == null) {
                nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Tally", NotificationManager.IMPORTANCE_LOW));
            }
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        int pf = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), pf);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, TallyService.class).setAction(STOP), pf);
        return b.setSmallIcon(android.R.drawable.presence_video_online)
                .setContentTitle("ATEM Tally")
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
                .build();
    }
}
