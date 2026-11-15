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
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Keeps a live connection to the ATEM (or the ATEM Switcher PC's tally stream) and draws the border over
 * every app (DJI Fly included): red when this input is on PROGRAM, green on PREVIEW.
 */
public final class TallyService extends Service {
    static final String STOP = "stop";
    /** runs the 12-second border test: red, green, transition, no connection */
    static final String TEST = "test";
    /** the look changed in the settings: redraw, no reconnect */
    static final String RESTYLE = "restyle";
    private static final String CHANNEL = "tally";
    private static final long TEST_STEP = 3000;
    private static final String[] TEST_LABELS = {"TEST: ON AIR", "TEST: PREVIEW", "TEST: TRANSITION", "TEST: NO CONNECTION"};
    static final int UNKNOWN = Integer.MIN_VALUE;

    // read by the settings screen for the connection meter
    static volatile int rssi = UNKNOWN;   // Wi-Fi signal, dBm
    static volatile int pingMs = -1;      // round trip to the ATEM / ATEM Switcher; -1 = not measured yet
    static volatile boolean linkOk;       // following the ATEM right now

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
    private volatile boolean viaSwitcher;

    // main thread only
    private long testStart, sampleUntil;
    private boolean lastOk, everOk, lostShown;
    private String lastNotice;

    static void start(Context c) {
        startFg(c, new Intent(c, TallyService.class));
    }

    static void test(Context c) {
        startFg(c, new Intent(c, TallyService.class).setAction(TEST));
    }

    /** redraw with the new look when the tally is on */
    static void restyle(Context c) {
        if (Prefs.get(c).getBoolean(Prefs.RUNNING, false)) startFg(c, new Intent(c, TallyService.class).setAction(RESTYLE));
    }

    private static void startFg(Context c, Intent i) {
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
        else c.startService(i);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (STOP.equals(action)) {
            Prefs.get(this).edit().putBoolean(Prefs.RUNNING, false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(1, notification("Connecting…"));
        boolean run = Prefs.get(this).getBoolean(Prefs.RUNNING, false);
        if (!run && !TEST.equals(action) && testStart == 0) {
            // restarted by Android after the user stopped it
            stopSelf();
            return START_NOT_STICKY;
        }
        if (border == null) addBorder();
        if (TEST.equals(action)) {
            testStart = SystemClock.uptimeMillis();
            if (run && worker == null) startWorker();
        } else if (RESTYLE.equals(action) && worker != null) {
            // show the new look for a moment even when this input is not on air
            sampleUntil = SystemClock.uptimeMillis() + 1500;
            drawIn(1600);
        } else {
            startWorker(); // (re)connect with the current settings
        }
        main.removeCallbacks(meterTick);
        main.post(meterTick);
        TallyTile.refresh(this);
        redraw();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopWorker();
        main.removeCallbacksAndMessages(null);
        linkOk = false;
        pingMs = -1;
        if (border != null) {
            try {
                wm.removeView(border);
            } catch (Exception ignored) {
            }
            border = null;
        }
        TallyTile.refresh(this);
        super.onDestroy();
    }

    private void startWorker() {
        stopWorker();
        lastOk = everOk = lostShown = false;
        Object token = new Object();
        current = token;
        worker = new Thread(() -> loop(token), "tally");
        worker.start();
        new Thread(() -> switcherPing(token), "tally-ping").start();
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
            pingMs = -1;
            // the ATEM Switcher PC (port 3000) gives names and works through Playout; else talk to the ATEM itself
            viaSwitcher = host.contains(":") || switcherAnswers(host);
            if (viaSwitcher) followSwitcher(token, host);
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

    /** the connection meter's round trip when the tally comes through the ATEM Switcher PC */
    private void switcherPing(Object token) {
        while (current == token) {
            sleep(2000);
            if (current != token || !viaSwitcher || !connected) continue;
            String host = Prefs.get(this).getString(Prefs.HOST, Prefs.DEFAULT_HOST);
            long t0 = System.nanoTime();
            boolean ok = switcherAnswers(host);
            if (current == token) pingMs = ok ? (int) Math.max(1, (System.nanoTime() - t0) / 1_000_000) : AtemClient.PING_LOST;
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
        }).pinging(ms -> {
            if (current == token) pingMs = ms;
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

    // ---- connection meter ----
    private final Runnable meterTick = new Runnable() {
        @Override
        public void run() {
            rssi = readRssi(TallyService.this);
            draw();
            main.postDelayed(this, 2000);
        }
    };

    /** dBm of the Wi-Fi this controller is on, or UNKNOWN */
    static int readRssi(Context c) {
        try {
            WifiManager w = (WifiManager) c.getApplicationContext().getSystemService(WIFI_SERVICE);
            WifiInfo info = w == null ? null : w.getConnectionInfo();
            int r = info == null ? UNKNOWN : info.getRssi();
            return r <= -127 || r >= 0 ? UNKNOWN : r;
        } catch (Exception e) {
            return UNKNOWN;
        }
    }

    /** 0-4 bars from the Wi-Fi signal and the round trip to the ATEM */
    static int bars(boolean ok, int rssi, int ping) {
        if (!ok) return 0;
        int b = rssi == UNKNOWN ? 4 : rssi >= -55 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : 1;
        if (ping >= 400) b = Math.min(b, 1);
        else if (ping >= 150) b = Math.min(b, 2);
        else if (ping >= 60) b = Math.min(b, 3);
        return b;
    }

    // ---- drawing ----
    private void redraw() {
        main.post(this::draw);
    }

    private final Runnable drawLater = this::draw;

    /** one draw at a set time (test steps, end of the look sample) */
    private void drawIn(long ms) {
        main.removeCallbacks(drawLater);
        main.postDelayed(drawLater, ms);
    }

    private void draw() {
        SharedPreferences p = Prefs.get(this);
        long now = SystemClock.uptimeMillis();
        int input = p.getInt(Prefs.INPUT, 1);
        boolean running = worker != null;
        boolean ok = running && connected && atem;
        linkOk = ok;
        boolean onAir = ok && (program == input || (inTransition && preview == input));
        boolean onPreview = ok && !onAir && preview == input && p.getBoolean(Prefs.PREVIEW, true);

        BorderView.Look look = new BorderView.Look();
        look.color = onAir ? BorderView.RED : onPreview ? BorderView.GREEN : 0;
        look.pulse = onAir && inTransition && p.getBoolean(Prefs.PULSE, true);
        look.label = !p.getBoolean(Prefs.LABEL, false) || look.color == 0 ? null : onAir ? "ON AIR" : "PREVIEW";
        look.lost = running && !ok;
        look.widthPx = Math.round(p.getInt(Prefs.WIDTH, 6) * getResources().getDisplayMetrics().density);
        look.style = p.getInt(Prefs.STYLE, BorderView.STYLE_FULL);
        look.sides = Prefs.sideBits(p.getInt(Prefs.SIDES, 0));
        look.opacity = p.getInt(Prefs.OPACITY, 100);
        look.bars = running && p.getBoolean(Prefs.METER, false) ? bars(ok, rssi, pingMs) : -1;

        if (testStart != 0) {
            long t = now - testStart;
            int step = (int) (t / TEST_STEP);
            if (step < TEST_LABELS.length) {
                look.color = step == 0 || step == 2 ? BorderView.RED : step == 1 ? BorderView.GREEN : 0;
                look.pulse = step == 2;
                look.lost = step == 3;
                look.label = TEST_LABELS[step];
                drawIn(TEST_STEP - t % TEST_STEP + 20);
            } else {
                testStart = 0;
                message("Test done", BorderView.GREEN);
                if (!running) {
                    // only started for the test
                    if (border != null) border.show(new BorderView.Look());
                    main.removeCallbacks(meterTick);
                    main.postDelayed(() -> {
                        if (worker == null && testStart == 0) stopSelf();
                    }, 3000);
                    return;
                }
            }
        } else if (now < sampleUntil && look.color == 0) {
            look.color = BorderView.RED;
            look.label = p.getBoolean(Prefs.LABEL, false) ? "ON AIR" : null;
        }
        if (border != null) border.show(look);
        if (running) connectionMessages(ok);

        String status = !running ? "Border test"
                : !connected ? "Looking for the ATEM at " + p.getString(Prefs.HOST, Prefs.DEFAULT_HOST)
                : !atem ? "ATEM Switcher has no ATEM connected"
                : inputName + (onAir ? ": ON AIR" : onPreview ? ": PREVIEW" : ": not on air");
        if (!status.equals(lastNotice)) {
            lastNotice = status;
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.notify(1, notification(status));
        }
    }

    /** "Tally connected", then "connection lost" (after 2.5 s, so a short drop shows nothing) and "Reconnected" */
    private void connectionMessages(boolean ok) {
        if (ok == lastOk) return;
        lastOk = ok;
        main.removeCallbacks(lostLater);
        if (ok) {
            if (lostShown) message("Tally reconnected", BorderView.GREEN);
            else if (!everOk) message("Tally connected: " + inputName, BorderView.GREEN);
            everOk = true;
            lostShown = false;
        } else if (everOk) {
            main.postDelayed(lostLater, 2500);
        }
    }

    private final Runnable lostLater = () -> {
        if (lastOk || worker == null) return;
        lostShown = true;
        message("Tally connection lost: reconnecting…", BorderView.ORANGE);
    };

    private void message(String text, int color) {
        if (!Prefs.get(this).getBoolean(Prefs.MESSAGES, true) && !text.startsWith("Test")) return;
        if (border != null) border.message(text, color, 3000);
        else Toast.makeText(this, text, Toast.LENGTH_SHORT).show();
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
