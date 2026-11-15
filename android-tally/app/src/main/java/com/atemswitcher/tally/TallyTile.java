package com.atemswitcher.tally;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/** "Tally" button in the quick settings (pull down from the top of the screen): turns the tally on and off. */
public final class TallyTile extends TileService {

    /** asks the quick settings to redraw the button after the tally started or stopped */
    static void refresh(Context c) {
        if (Build.VERSION.SDK_INT < 24) return;
        try {
            requestListeningState(c, new ComponentName(c, TallyTile.class));
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onStartListening() {
        show();
    }

    @Override
    public void onClick() {
        SharedPreferences p = Prefs.get(this);
        if (p.getBoolean(Prefs.RUNNING, false)) {
            p.edit().putBoolean(Prefs.RUNNING, false).apply();
            stopService(new Intent(this, TallyService.class));
        } else if (!Licence.ok(this) || (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this))) {
            openApp(); // the app asks for the licence key or "Display over other apps" first
        } else {
            p.edit().putBoolean(Prefs.RUNNING, true).apply();
            try {
                TallyService.start(this);
            } catch (Exception e) {
                // some Android versions do not let a tile start it: open the app instead
                p.edit().putBoolean(Prefs.RUNNING, false).apply();
                openApp();
            }
        }
        show();
    }

    @SuppressWarnings("deprecation")
    private void openApp() {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivityAndCollapse(i);
        } catch (Exception e) {
            startActivity(i);
        }
    }

    private void show() {
        Tile t = getQsTile();
        if (t == null) return;
        boolean on = Prefs.get(this).getBoolean(Prefs.RUNNING, false);
        t.setState(on ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        t.setLabel("Tally");
        if (Build.VERSION.SDK_INT >= 29) t.setSubtitle(on ? "On" : "Off");
        t.updateTile();
    }
}
