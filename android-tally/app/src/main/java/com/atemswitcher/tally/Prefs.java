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
    static final String SOURCES = "sources";
    /** 0 full border, 1 corners only, 2 dashed */
    static final String STYLE = "style";
    /** 0 all sides, 1 top, 2 bottom, 3 top and bottom, 4 left and right */
    static final String SIDES = "sides";
    /** border opacity, 20-100 % */
    static final String OPACITY = "opacity";
    /** the red border pulses while a transition (mix, dip, wipe) is running */
    static final String PULSE = "pulse";
    /** "Tally connected / connection lost / reconnected" messages over DJI Fly */
    static final String MESSAGES = "messages";
    /** small Wi-Fi signal bars in the corner over DJI Fly */
    static final String METER = "meter";
    /** the studio's ATEM: the tally talks to it directly when no ATEM Switcher PC is given */
    static final String DEFAULT_HOST = "192.168.1.125";

    /** SIDES -> BorderView side bits */
    static int sideBits(int sides) {
        switch (sides) {
            case 1: return BorderView.TOP;
            case 2: return BorderView.BOTTOM;
            case 3: return BorderView.TOP | BorderView.BOTTOM;
            case 4: return BorderView.LEFT | BorderView.RIGHT;
            default: return BorderView.ALL;
        }
    }

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
