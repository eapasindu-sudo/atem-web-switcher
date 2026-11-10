package com.atemswitcher.tally;

import android.content.Context;
import android.content.SharedPreferences;

/** Saved settings: where the ATEM Switcher is, which ATEM input this screen shows, how the border looks. */
final class Prefs {
    static final String HOST = "host";
    static final String INPUT = "input";
    static final String WIDTH = "width";
    static final String PREVIEW = "preview";
    static final String LABEL = "label";
    static final String RUNNING = "running";

    static SharedPreferences get(Context c) {
        return c.getSharedPreferences("tally", Context.MODE_PRIVATE);
    }

    /** "192.168.1.20" or "192.168.1.20:3000" -> "http://192.168.1.20:3000" */
    static String baseUrl(String host) {
        String h = host.trim();
        if (h.startsWith("http://")) h = h.substring(7);
        if (h.endsWith("/")) h = h.substring(0, h.length() - 1);
        if (!h.contains(":")) h = h + ":3000";
        return "http://" + h;
    }

    private Prefs() {}
}
