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
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
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
import java.io.File;
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
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Settings screen: find the ATEM Switcher PC, pick the ATEM input, allow drawing over apps, start. */
public final class MainActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean locked; // licence screen showing: the settings views were not built
    private SharedPreferences prefs;
    private EditText host;
    private Spinner input;
    private TextView status, widthLabel, opacityLabel, signal;
    private Button allow, find, start, test;
    private final List<Integer> inputIds = new ArrayList<>();
    private Button update;
    private boolean downloading;
    // the newest APK is always at the same link; tally-version.json next to it says which build it is
    static final String RELEASE = "https://github.com/eapasindu-sudo/atem-web-switcher/releases/download/tally-android/";
    static final String APK_URL = RELEASE + "ATEM-Tally.apk";

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = Prefs.get(this);
        if (!Licence.ok(this)) { locked = true; Licence.show(this, this::recreate); return; }
        Licence.refresh(this);
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
        update.setOnClickListener(v -> installUpdate());
        col.addView(update);
        status = text("", 15);
        status.setPadding(0, Math.round(4 * d), 0, Math.round(12 * d));
        col.addView(status);
        signal = text("", 13);
        col.addView(signal);

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
                TallyService.restyle(MainActivity.this);
            }
        });
        col.addView(width);
        col.addView(label("Border style"));
        col.addView(choice(new String[]{"Full border", "Corners only", "Dashed"}, Prefs.STYLE));
        col.addView(label("Border sides"));
        col.addView(choice(new String[]{"All sides", "Top only", "Bottom only", "Top and bottom", "Left and right"}, Prefs.SIDES));
        opacityLabel = label("");
        col.addView(opacityLabel);
        SeekBar opacity = new SeekBar(this);
        opacity.setMax(80); // 20-100 %
        opacity.setProgress(prefs.getInt(Prefs.OPACITY, 100) - 20);
        showOpacity();
        opacity.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar s, int p, boolean user) {
                prefs.edit().putInt(Prefs.OPACITY, p + 20).apply();
                showOpacity();
            }

            @Override
            public void onStartTrackingTouch(SeekBar s) {
            }

            @Override
            public void onStopTrackingTouch(SeekBar s) {
                TallyService.restyle(MainActivity.this);
            }
        });
        col.addView(opacity);
        col.addView(check("Green border when on PREVIEW", Prefs.PREVIEW, true));
        col.addView(check("Show ON AIR / PREVIEW text at the top", Prefs.LABEL, false));
        col.addView(check("Red border pulses during a transition", Prefs.PULSE, true));
        col.addView(check("Show \"connected / connection lost / reconnected\" messages", Prefs.MESSAGES, true));
        col.addView(check("Wi-Fi signal bars in the top-left corner", Prefs.METER, false));

        // 4. permission and start
        allow = new Button(this);
        allow.setText("Allow \"Display over other apps\"");
        allow.setOnClickListener(v -> askOverlay());
        col.addView(allow);
        start = new Button(this);
        start.setOnClickListener(v -> toggle());
        Button licence = new Button(this);
        licence.setText("Licence key");
        licence.setOnClickListener(v -> Licence.show(this, this::recreate));
        col.addView(licence);
        col.addView(start);
        test = new Button(this);
        test.setText("Test the border (12 s): red, green, transition, no connection");
        test.setOnClickListener(v -> {
            if (canDraw()) TallyService.test(this);
        });
        col.addView(test);

        TextView help = text("Red border = this drone is ON AIR (PROGRAM), green = PREVIEW. "
                + "Start it, then open DJI Fly: the border stays on top. "
                + "An orange dot in the corner means the tally is not connected. "
                + "Find looks for the ATEM on this Wi-Fi and picks the input named DRONE (or DJI) by itself. "
                + "Stop it from the notification, from the Tally button in the quick settings, or here.", 13);
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
                    update.setText("Update available (1.0." + latest + "): tap to install it");
                    update.setVisibility(View.VISIBLE);
                });
            } catch (Exception ignored) {
                // no internet: nothing to show
            }
        }).start();
    }

    /** downloads the new APK here and hands it to Android's installer, which asks "Update this app?" */
    private void installUpdate() {
        if (downloading) return;
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            status.setText("Allow \"Install unknown apps\" for ATEM Tally, come back, then tap Update again.");
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
            } catch (ActivityNotFoundException e) {
                status.setText("This controller has no setting for installing apps. Download the APK on a PC: " + APK_URL);
            }
            return;
        }
        downloading = true;
        update.setEnabled(false);
        update.setText("Downloading update… 0%");
        new Thread(() -> {
            try {
                File apk = new File(getCacheDir(), "ATEM-Tally-update.apk");
                Updater.download(APK_URL, apk, pct -> main.post(() -> update.setText("Downloading update… " + pct + "%")));
                main.post(() -> update.setText("Installing… tap Update (or Install) when Android asks"));
                Updater.install(this, apk);
            } catch (Exception e) {
                main.post(() -> {
                    update.setText("Update failed: tap to try again");
                    status.setText("Could not download the update (" + e.getMessage() + "). Is this controller on the internet?");
                });
            } finally {
                main.post(() -> {
                    downloading = false;
                    update.setEnabled(true);
                });
            }
        }).start();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (locked) return;
        refresh();
        main.removeCallbacks(meter);
        main.post(meter);
        if (inputIds.size() == 8 && !prefs.getString(Prefs.SOURCES, "").isEmpty()) savedInputs();
    }

    @Override
    protected void onPause() {
        main.removeCallbacks(meter);
        if (!locked) saveHost();
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
            TallyService.restyle(this);
        });
        return c;
    }

    /** a drop-down that saves the chosen position under key */
    private Spinner choice(String[] items, String key) {
        Spinner sp = new Spinner(this);
        ArrayAdapter<String> a = new ArrayAdapter<String>(this, android.R.layout.simple_spinner_item, items) {
            @Override
            public View getView(int pos, View v, ViewGroup parent) {
                View view = super.getView(pos, v, parent);
                ((TextView) view).setTextColor(Color.WHITE);
                ((TextView) view).setTextSize(16);
                return view;
            }
        };
        a.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        sp.setAdapter(a);
        sp.setSelection(Math.max(0, Math.min(items.length - 1, prefs.getInt(key, 0))));
        sp.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int pos, long id) {
                if (pos == prefs.getInt(key, 0)) return;
                prefs.edit().putInt(key, pos).apply();
                TallyService.restyle(MainActivity.this);
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
            }
        });
        return sp;
    }

    private void showOpacity() {
        opacityLabel.setText("Border opacity: " + prefs.getInt(Prefs.OPACITY, 100) + "%");
    }

    // ---- connection meter ----
    private final Runnable meter = new Runnable() {
        @Override
        public void run() {
            showSignal();
            main.postDelayed(this, 1000);
        }
    };

    private static final String[] QUALITY = {"no connection", "poor", "weak", "good", "excellent"};

    /** "Signal ▂▄▆█ good · Wi-Fi -52 dBm · ping 4 ms" */
    private void showSignal() {
        boolean on = running();
        int rssi = on ? TallyService.rssi : TallyService.readRssi(this);
        if (rssi == TallyService.UNKNOWN) rssi = TallyService.readRssi(this);
        int ping = on ? TallyService.pingMs : -1;
        SpannableStringBuilder sb = new SpannableStringBuilder();
        if (on) {
            int bars = TallyService.bars(TallyService.linkOk, rssi, ping);
            int color = bars >= 3 ? Color.rgb(0, 200, 60) : bars == 2 ? Color.rgb(255, 210, 0) : Color.rgb(235, 60, 60);
            sb.append("Signal ");
            String glyphs = "▂▄▆█";
            for (int i = 0; i < 4; i++) {
                int startAt = sb.length();
                sb.append(glyphs.charAt(i));
                sb.setSpan(new ForegroundColorSpan(i < bars ? color : Color.rgb(80, 80, 80)), startAt, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
            sb.append(" ").append(QUALITY[bars]);
        } else {
            sb.append("Connection");
        }
        sb.append(" · Wi-Fi ").append(rssi == TallyService.UNKNOWN ? "–" : rssi + " dBm");
        if (on) {
            sb.append(" · ping ").append(ping < 0 ? "–" : ping >= AtemClient.PING_LOST ? "no answer" : ping + " ms");
        }
        signal.setText(sb);
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
        test.setEnabled(ok);
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
            boolean direct = atem.get() != null;
            String h = direct ? atem.get() : found.get();
            // then the input names, so the drone's input can be picked by its name
            JSONArray sources = null;
            if (h != null) {
                main.post(() -> status.setText("Found it at " + h + ". Reading the input names…"));
                try {
                    if (direct) {
                        Map<Integer, String> names = AtemClient.readNames(h, 4000);
                        if (!names.isEmpty()) {
                            sources = new JSONArray();
                            for (Map.Entry<Integer, String> e : names.entrySet()) {
                                sources.put(new JSONObject().put("id", e.getKey()).put("label", e.getValue()));
                            }
                            prefs.edit().putString(Prefs.SOURCES, sources.toString()).apply();
                        }
                    } else {
                        sources = new JSONObject(get("http://" + h + ":3000/api/tally", 3000)).getJSONArray("sources");
                    }
                } catch (Exception ignored) {
                }
            }
            JSONArray src = sources;
            main.post(() -> {
                find.setEnabled(true);
                if (h == null) {
                    status.setText("No ATEM found on this Wi-Fi. Is the ATEM plugged into the same router with a network cable? You can also type its IP.");
                    return;
                }
                String picked = src == null ? null : pickDrone(src);
                host.setText(h);
                saveHost();
                if (src != null) setInputs(src);
                String where = (direct ? "Found the ATEM at " : "Found the ATEM Switcher at ") + h + ". ";
                status.setText(picked != null
                        ? where + "Drone input: " + picked + " (picked by its name). Tap Start tally."
                        : where + "Pick the drone's ATEM input below, then tap Start tally. "
                        + "Tip: name that input DRONE on the ATEM and Find picks it by itself.");
            });
        }).start();
    }

    /** picks the input named DRONE / DJI / UAV; returns "5  DRONE", or null when there is none */
    private String pickDrone(JSONArray sources) {
        for (int i = 0; i < sources.length(); i++) {
            JSONObject s = sources.optJSONObject(i);
            if (s == null) continue;
            String label = s.optString("label");
            String up = label.toUpperCase(java.util.Locale.ROOT);
            if (up.contains("DRON") || up.contains("DJI") || up.contains("UAV")) {
                int id = s.optInt("id");
                if (id != prefs.getInt(Prefs.INPUT, 1)) {
                    prefs.edit().putInt(Prefs.INPUT, id).apply();
                    restartIfRunning();
                }
                return id + "  " + label;
            }
        }
        return null;
    }
}
