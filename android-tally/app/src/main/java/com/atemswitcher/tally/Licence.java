package com.atemswitcher.tally;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.security.MessageDigest;

/** Endora licence key: checked with the Endora server, works 7 days offline. No free trial. */
final class Licence {
    static final String PRODUCT = "atem-tally";
    static final String API = "https://www.endoraweddingfilms.com/perfex_crm/endora_bridge/shop/check";
    static final String BUY = "https://tools.endoraweddingfilms.com/#atem-tally";
    static final long DAY = 86400000L, GRACE = 7 * DAY, RECHECK = 12 * 3600000L;

    private Licence() {}

    private static SharedPreferences p(Context c) { return c.getSharedPreferences("endora_licence", Context.MODE_PRIVATE); }

    static String machine(Context c) {
        try {
            String id = Settings.Secure.getString(c.getContentResolver(), Settings.Secure.ANDROID_ID);
            byte[] h = MessageDigest.getInstance("SHA-256").digest(("tally|" + id).getBytes("UTF-8"));
            StringBuilder s = new StringBuilder();
            for (int i = 0; i < 16; i++) s.append(String.format("%02x", h[i]));
            return s.toString();
        } catch (Exception e) { return "android"; }
    }

    /** True when the app may run now. */
    static boolean ok(Context c) {
        SharedPreferences s = p(c);
        if (!s.getBoolean("valid", false) || s.getString("key", "").isEmpty()) return false;
        if (System.currentTimeMillis() - s.getLong("lastOk", 0) > GRACE) return false;
        String exp = s.getString("expires", "");
        if (!exp.isEmpty() && exp.compareTo(new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(new java.util.Date())) < 0) return false;
        return true;
    }

    /** Server answer for a key (call off the main thread). */
    static JSONObject check(Context c, String key) throws Exception {
        String u = API + "?key=" + URLEncoder.encode(key, "UTF-8") + "&product=" + PRODUCT + "&machine=" + machine(c);
        HttpURLConnection h = (HttpURLConnection) new URL(u).openConnection();
        h.setConnectTimeout(10000); h.setReadTimeout(15000);
        try (InputStream in = h.getInputStream()) {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            byte[] b = new byte[4096]; int n;
            while ((n = in.read(b)) > 0) o.write(b, 0, n);
            return new JSONObject(o.toString("UTF-8"));
        } finally { h.disconnect(); }
    }

    private static void store(Context c, String key, JSONObject j) {
        p(c).edit().putString("key", key).putBoolean("valid", j.optBoolean("valid"))
            .putLong("lastOk", j.optBoolean("valid") ? System.currentTimeMillis() : p(c).getLong("lastOk", 0))
            .putString("expires", j.isNull("expires") ? "" : j.optString("expires", ""))
            .putString("reason", j.optString("reason", "")).apply();
    }

    /** Re-check the saved key in the background (network errors keep the last good answer). */
    static void refresh(Context c) {
        String key = p(c).getString("key", "");
        if (key.isEmpty() || System.currentTimeMillis() - p(c).getLong("lastOk", 0) < RECHECK) return;
        new Thread(() -> { try { JSONObject j = check(c, key); if (j.optBoolean("ok")) store(c, key, j); } catch (Exception ignored) { } }).start();
    }

    /** Full-screen "Enter your licence key". onDone runs on the main thread once the key is accepted. */
    static void show(Activity a, Runnable onDone) {
        float d = a.getResources().getDisplayMetrics().density;
        int pad = Math.round(24 * d);
        LinearLayout col = new LinearLayout(a);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER);
        col.setPadding(pad, pad, pad, pad);
        col.setBackgroundColor(Color.rgb(11, 10, 9));
        TextView t = new TextView(a);
        t.setText("ATEM Tally"); t.setTextSize(26); t.setTextColor(Color.rgb(200, 169, 106)); t.setGravity(Gravity.CENTER);
        TextView m = new TextView(a);
        String reason = p(a).getString("reason", "");
        m.setText(ok(a) ? "Licensed with key " + p(a).getString("key", "") + ". Enter another key to replace it." : !reason.isEmpty() ? reason : p(a).getString("key", "").isEmpty() ? "Enter your licence key to start." : "Connect to the internet once so the app can check your licence.");
        m.setTextColor(Color.rgb(200, 200, 200)); m.setGravity(Gravity.CENTER); m.setPadding(0, pad / 2, 0, pad / 2);
        EditText k = new EditText(a);
        k.setHint("EWF-TLY-XXXX-XXXX-XXXX"); k.setText(p(a).getString("key", ""));
        k.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS);
        k.setTextColor(Color.WHITE); k.setHintTextColor(Color.GRAY); k.setGravity(Gravity.CENTER);
        Button go = new Button(a); go.setText("Activate");
        Button buy = new Button(a); buy.setText("Buy a licence");
        TextView e = new TextView(a); e.setTextColor(Color.rgb(255, 138, 128)); e.setGravity(Gravity.CENTER);
        col.addView(t); col.addView(m); col.addView(k); col.addView(go); col.addView(e); col.addView(buy);
        a.setContentView(col);
        Handler main = new Handler(Looper.getMainLooper());
        buy.setOnClickListener(v -> { try { a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(BUY))); } catch (Exception ignored) { } });
        go.setOnClickListener(v -> {
            String key = k.getText().toString().trim().toUpperCase(java.util.Locale.US);
            if (key.isEmpty()) { e.setText("Paste the licence key from your WhatsApp message."); return; }
            go.setEnabled(false); e.setText("Checking…");
            new Thread(() -> {
                String err;
                try {
                    JSONObject j = check(a, key);
                    if (j.optBoolean("ok") && j.optBoolean("valid")) { store(a, key, j); main.post(onDone); return; }
                    err = j.optString("reason", "This licence key is not valid for this app.");
                } catch (Exception ex) { err = "Could not reach the licence server. Check the internet."; }
                final String msg = err;
                main.post(() -> { go.setEnabled(true); e.setText(msg); });
            }).start();
        });
    }
}
