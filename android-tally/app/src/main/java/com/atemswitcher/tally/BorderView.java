package com.atemswitcher.tally;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.view.View;

/** Full-screen see-through view: draws only a coloured frame round the edge (and an optional label). */
final class BorderView extends View {
    static final int RED = Color.rgb(235, 0, 0);
    static final int GREEN = Color.rgb(0, 200, 60);
    static final int ORANGE = Color.rgb(255, 150, 0);

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint text = new Paint(Paint.ANTI_ALIAS_FLAG);
    private int color = 0;
    private int widthPx = 12;
    private String label = null;
    private boolean lost = false;

    BorderView(Context c) {
        super(c);
        text.setColor(Color.WHITE);
        text.setFakeBoldText(true);
        text.setTextSize(14 * getResources().getDisplayMetrics().density);
    }

    /** color 0 = nothing; lost = no connection (a small orange dot in the corner) */
    void show(int color, int widthPx, String label, boolean lost) {
        if (this.color == color && this.widthPx == widthPx && eq(this.label, label) && this.lost == lost) return;
        this.color = color;
        this.widthPx = widthPx;
        this.label = label;
        this.lost = lost;
        invalidate();
    }

    private static boolean eq(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }

    @Override
    protected void onDraw(Canvas c) {
        int w = getWidth(), h = getHeight(), b = widthPx;
        if (color != 0) {
            paint.setColor(color);
            c.drawRect(0, 0, w, b, paint);
            c.drawRect(0, h - b, w, h, paint);
            c.drawRect(0, 0, b, h, paint);
            c.drawRect(w - b, 0, w, h, paint);
            if (label != null) {
                float pad = 6 * getResources().getDisplayMetrics().density;
                float tw = text.measureText(label);
                float th = text.getTextSize();
                c.drawRect(w / 2f - tw / 2 - pad, b, w / 2f + tw / 2 + pad, b + th + pad * 1.5f, paint);
                c.drawText(label, w / 2f - tw / 2, b + th + pad * 0.5f, text);
            }
        }
        if (lost) {
            float r = 6 * getResources().getDisplayMetrics().density;
            paint.setColor(ORANGE);
            c.drawCircle(r * 2, r * 2, r, paint);
        }
    }
}
