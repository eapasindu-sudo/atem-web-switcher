package com.atemswitcher.tally;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Spinner;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Settings screen: find the ATEM Switcher PC, pick the ATEM input, allow drawing over apps, start. */
public final class MainActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private EditText host;
    private Spinner input;
    private TextView status, widthLabel;
    private Button allow, find, start;
    private final List<Integer> inputIds = new ArrayList<>();
    private Button update;
    // the newest APK is always at the same link; tally-version.json next to it says which build it is
    static final String RELEASE = "https://github.com/eapasindu-sudo/atem-web-switcher/releases/download/tally-android/";
    static final String APK_URL = RELEASE + "ATEM-Tally.apk";

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = Prefs.get(this);
        float d = getResources().getDisplayMetrics().density;
        int pad = Math.round(16 * d);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(pad, pad, pad, pad);
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(24, 24, 26));
        scroll.addView(col);
        setContentView(scroll);

        TextView title = text("ATEM Tally", 24);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        col.addView(title);
        update = new Button(this);
        update.setVisibility(View.GONE);
        update.setOnClickListener(v -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(APK_URL))));
        col.addView(update);
        status = text("", 15);
        status.setPadding(0, Math.round(4 * d), 0, Math.round(12 * d));
        col.addView(status);

        // 1. where the ATEM Switcher runs
        col.addView(label("ATEM IP address (or the ATEM Switcher PC), on the same Wi-Fi as this controller"));
        LinearLayout row = new LinearLayout(this);
        host = new EditText(this);
        host.setHint("ATEM IP, e.g. " + Prefs.DEFAULT_HOST);
        host.setTextColor(Color.WHITE);
        host.setHintTextColor(Color.GRAY);
        host.setSingleLine(true);
        host.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        host.setText(prefs.getString(Prefs.HOST, Prefs.DEFAULT_HOST));
        host.setOnFocusChangeListener((v, has) -> {
            if (!has) saveHost();
        });
        row.addView(host, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        find = new Button(this);
        find.setText("Find");
        find.setOnClickListener(v -> findSwitcher());
        row.addView(find);
        col.addView(row);

        // 2. which ATEM input this drone is plugged into
        col.addView(label("ATEM input of this drone"));
        input = new Spinner(this);
        col.addView(input);
        setInputs(null);
        input.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int pos, long id) {
                int v = inputIds.get(pos);
                if (v != prefs.getInt(Prefs.INPUT, 1)) {
                    prefs.edit().putInt(Prefs.INPUT, v).apply();
                    restartIfRunning();
                }
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
            }
        });

        // 3. how it looks
        widthLabel = label("");
        col.addView(widthLabel);
        SeekBar width = new SeekBar(this);
        width.setMax(28);
        width.setProgress(prefs.getInt(Prefs.WIDTH, 6) - 2);
        showWidth();
        width.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar s, int p, boolean user) {
                prefs.edit().putInt(Prefs.WIDTH, p + 2).apply();
                showWidth();
            }

            @Override
            public void onStartTrackingTouch(SeekBar s) {
            }

            @Override
            public void onStopTrackingTouch(SeekBar s) {
                restartIfRunning();
            }
        });
        col.addView(width);
        col.addView(check("Green border when on PREVIEW", Prefs.PREVIEW, true));
        col.addView(check("Show ON AIR / PREVIEW text at the top", Prefs.LABEL, false));

        // 4. permission and start
        allow = new Button(this);
        allow.setText("Allow \"Display over other apps\"");
        allow.setOnClickListener(v -> askOverlay());
        col.addView(allow);
        start = new Button(this);
        start.setOnClickListener(v -> toggle());
        col.addView(start);

        TextView help = text("Red border = this drone is ON AIR (PROGRAM), green = PREVIEW. "
                + "Start it, then open DJI Fly: the border stays on top. "
                + "An orange dot in the corner means the tally is not connected. "
                + "Stop it from the notification or here.", 13);
        help.setTextColor(Color.GRAY);
        help.setPadding(0, Math.round(12 * d), 0, 0);
        col.addView(help);

        if (!prefs.getString(Prefs.HOST, Prefs.DEFAULT_HOST).isEmpty()) loadInputs();
        checkUpdate();
    }

    /** shows "Update available" when GitHub has a newer build than this one */
    private void checkUpdate() {
        new Thread(() -> {
            try {
                int latest = new JSONObject(get(RELEASE + "tally-version.json", 8000)).getInt("versionCode");
                long mine = Build.VERSION.SDK_INT >= 28
                        ? getPackageManager().getPackageInfo(getPackageName(), 0).getLongVersionCode()
                        : getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
                if (latest > mine) main.post(() -> {
                    update.setText("Update available (1.0." + latest + "): tap to download, then install it");
                    update.setVisibility(View.VISIBLE);
                });
            } catch (Exception ignored) {
                // no internet: nothing to show
            }
        }).start();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
        if (inputIds.size() == 8 && !prefs.getString(Prefs.SOURCES, "").isEmpty()) savedInputs();
    }

    @Override
    protected void onPause() {
        saveHost();
        super.onPause();
    }

    private TextView text(String s, int sp) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(Color.WHITE);
        return t;
    }

    private TextView label(String s) {
        TextView t = text(s, 13);
        t.setTextColor(Color.rgb(170, 170, 170));
        t.setPadding(0, Math.round(14 * getResources().getDisplayMetrics().density), 0, 0);
        return t;
    }

    private CheckBox check(String s, String key, boolean def) {
        CheckBox c = new CheckBox(this);
        c.setText(s);
        c.setTextColor(Color.WHITE);
        c.setChecked(prefs.getBoolean(key, def));
        c.setOnCheckedChangeListener((v, on) -> {
            prefs.edit().putBoolean(key, on).apply();
            restartIfRunning();
        });
        return c;
    }

    private void showWidth() {
        widthLabel.setText("Border thickness: " + prefs.getInt(Prefs.WIDTH, 6));
    }

    private boolean canDraw() {
        return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this);
    }

    private boolean running() {
        return prefs.getBoolean(Prefs.RUNNING, false);
    }

    private void refresh() {
        boolean ok = canDraw();
        allow.setVisibility(ok ? View.GONE : View.VISIBLE);
        start.setEnabled(ok);
        start.setText(running() ? "Stop tally" : "Start tally");
        if (!ok) status.setText("Step 1: allow \"Display over other apps\" so the border can show over DJI Fly.");
        else if (prefs.getString(Prefs.HOST, Prefs.DEFAULT_HOST).isEmpty()) status.setText("Enter the ATEM's IP address, or tap Find.");
        else status.setText(running() ? "Tally is on. Open DJI Fly." : "Ready. Tap Start tally.");
    }

    private void saveHost() {
        String h = host.getText().toString().trim();
        if (h.equals(prefs.getString(Prefs.HOST, Prefs.DEFAULT_HOST))) return;
        prefs.edit().putString(Prefs.HOST, h).apply();
        if (!h.isEmpty()) loadInputs();
        restartIfRunning();
        refresh();
    }

    private void askOverlay() {
        if (Build.VERSION.SDK_INT < 23) return;
        try {
            startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
        } catch (ActivityNotFoundException e) {
            try {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
            } catch (ActivityNotFoundException e2) {
                status.setText("This controller has no settings page for it. On a PC run: adb shell appops set "
                        + getPackageName() + " SYSTEM_ALERT_WINDOW allow");
            }
        }
    }

    private void toggle() {
        saveHost();
        if (running()) {
            prefs.edit().putBoolean(Prefs.RUNNING, false).apply();
            stopService(new Intent(this, TallyService.class));
        } else {
            if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1);
            prefs.edit().putBoolean(Prefs.RUNNING, true).apply();
            TallyService.start(this);
        }
        refresh();
    }

    private void restartIfRunning() {
        if (running() && canDraw()) TallyService.start(this);
    }

    // ---- talking to the ATEM Switcher ----
    private static String get(String url, int timeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(timeoutMs);
        c.setReadTimeout(timeoutMs);
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } finally {
            c.disconnect();
        }
    }

    /** fills the input list with the ATEM's own names (CAM 1, DRONE …) */
    private void loadInputs() {
        String base = Prefs.baseUrl(prefs.getString(Prefs.HOST, Prefs.DEFAULT_HOST));
        new Thread(() -> {
            try {
                JSONArray sources = new JSONObject(get(base + "/api/tally", 3000)).getJSONArray("sources");
                main.post(() -> setInputs(sources));
            } catch (Exception e) {
                // not an ATEM Switcher PC: the tally talks to the ATEM itself and saves its input names
                main.post(this::savedInputs);
            }
        }).start();
    }

    private void savedInputs() {
        try {
            setInputs(new JSONArray(prefs.getString(Prefs.SOURCES, "[]")));
        } catch (Exception ignored) {
        }
    }

    private void setInputs(JSONArray sources) {
        List<String> names = new ArrayList<>();
        inputIds.clear();
        if (sources != null) {
            for (int i = 0; i < sources.length(); i++) {
                JSONObject s = sources.optJSONObject(i);
                if (s == null) continue;
                inputIds.add(s.optInt("id"));
                names.add(s.optInt("id") + "  " + s.optString("label"));
            }
        }
        if (inputIds.isEmpty()) {
            for (int i = 1; i <= 8; i++) {
                inputIds.add(i);
                names.add("Input " + i);
            }
        }
        ArrayAdapter<String> a = new ArrayAdapter<String>(this, android.R.layout.simple_spinner_item, names) {
            @Override
            public View getView(int pos, View v, ViewGroup parent) {
                View view = super.getView(pos, v, parent);
                ((TextView) view).setTextColor(Color.WHITE);
                ((TextView) view).setTextSize(18);
                return view;
            }
        };
        a.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        input.setAdapter(a);
        int cur = inputIds.indexOf(prefs.getInt(Prefs.INPUT, 1));
        input.setSelection(Math.max(0, cur));
    }

    /** tries every address on this Wi-Fi (x.x.x.1-254) for an ATEM Switcher on port 3000 */
    private void findSwitcher() {
        find.setEnabled(false);
        status.setText("Looking for the ATEM on this Wi-Fi…");
        new Thread(() -> {
            AtomicReference<String> found = new AtomicReference<>();
            AtomicReference<String> atem = new AtomicReference<>();
            ExecutorService pool = Executors.newFixedThreadPool(48);
            try {
                for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                    if (!ni.isUp() || ni.isLoopback()) continue;
                    for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                        if (!(a instanceof Inet4Address) || !a.isSiteLocalAddress()) continue;
                        byte[] ip = a.getAddress();
                        String prefix = (ip[0] & 255) + "." + (ip[1] & 255) + "." + (ip[2] & 255) + ".";
                        for (int i = 1; i < 255; i++) {
                            String h = prefix + i;
                            pool.execute(() -> {
                                if (atem.get() != null) return;
                                try {
                                    if (AtemClient.probe(InetAddress.getByName(h), 800)) atem.compareAndSet(null, h);
                                    else if (get("http://" + h + ":3000/api/tally", 700).contains("\"sources\"")) found.compareAndSet(null, h);
                                } catch (Exception ignored) {
                                }
                            });
                        }
                    }
                }
            } catch (Exception ignored) {
            }
            pool.shutdown();
            try {
                pool.awaitTermination(20, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
            }
            main.post(() -> {
                find.setEnabled(true);
                String h = atem.get() != null ? atem.get() : found.get();
                if (h == null) {
                    status.setText("No ATEM found on this Wi-Fi. Is the ATEM plugged into the same router with a network cable? You can also type its IP.");
                    return;
                }
                host.setText(h);
                saveHost();
                status.setText((atem.get() != null ? "Found the ATEM at " : "Found the ATEM Switcher at ") + h + ". Pick the drone's ATEM input, then Start tally.");
            });
        }).start();
    }
}
