package com.atemswitcher.tally;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.widget.Toast;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.function.IntConsumer;

/** Downloads the newest APK and installs it over this one (Android asks the user to confirm). */
final class Updater {
    private Updater() {}

    /** downloads url to file; progress gets 0-100 */
    static void download(String url, File file, IntConsumer progress) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true); // GitHub sends the file from another address
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(file)) {
            if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
            long total = c.getContentLengthLong(), done = 0;
            byte[] buf = new byte[64 * 1024];
            int n, last = -1;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                done += n;
                int pct = total > 0 ? (int) (done * 100 / total) : 0;
                if (pct != last) progress.accept(last = pct);
            }
        } finally {
            c.disconnect();
        }
    }

    /** hands the APK to Android's installer; Result shows the "Update?" screen */
    static void install(Context c, File apk) throws Exception {
        PackageInstaller pi = c.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams sp = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        sp.setAppPackageName(c.getPackageName());
        sp.setSize(apk.length());
        int id = pi.createSession(sp);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (InputStream in = new FileInputStream(apk); OutputStream out = s.openWrite("ATEM-Tally.apk", 0, apk.length())) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                s.fsync(out);
            }
            // Android fills in the result, so this one has to be mutable
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent done = PendingIntent.getBroadcast(c, 7, new Intent(c, Result.class), flags);
            s.commit(done.getIntentSender());
        }
    }

    /** after an update Android stops the app: start the tally again if it was on */
    public static final class Restart extends BroadcastReceiver {
        @Override
        public void onReceive(Context c, Intent i) {
            if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(i.getAction())) return;
            if (!Prefs.get(c).getBoolean(Prefs.RUNNING, false) || !Licence.ok(c)) return;
            if (Build.VERSION.SDK_INT >= 23 && !android.provider.Settings.canDrawOverlays(c)) return;
            try {
                TallyService.start(c);
            } catch (Exception ignored) {
            }
        }
    }

    /** the installer's answer: show its confirm screen, or say why it failed */
    public static final class Result extends BroadcastReceiver {
        @Override
        @SuppressWarnings("deprecation")
        public void onReceive(Context c, Intent i) {
            int status = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    c.startActivity(confirm);
                }
            } else if (status != PackageInstaller.STATUS_SUCCESS) {
                String why = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                Toast.makeText(c, "Update not installed" + (why != null ? ": " + why : ""), Toast.LENGTH_LONG).show();
            }
        }
    }
}
