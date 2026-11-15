package com.atemswitcher.tally;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.os.SystemClock;
import android.view.View;

/**
 * Full-screen see-through view: draws only a coloured frame round the edge, plus an optional label,
 * signal bars and short messages ("Reconnected").
 */
final class BorderView extends View {
    static final int RED = Color.rgb(235, 0, 0);
    static final int GREEN = Color.rgb(0, 200, 60);
    static final int ORANGE = Color.rgb(255, 150, 0);
    private static final int YELLOW = Color.rgb(255, 210, 0);

    static final int STYLE_FULL = 0, STYLE_CORNERS = 1, STYLE_DASHED = 2;
    static final int TOP = 1, BOTTOM = 2, LEFT = 4, RIGHT = 8, ALL = 15;

    /** everything the frame shows; the service fills one in and calls show() */
    static final class Look {
        int color;          // 0 = no border
        int widthPx = 12;
        String label;       // "ON AIR" at the top, or null
        boolean lost;       // no connection: a small orange dot in the corner
        int style = STYLE_FULL;
        int sides = ALL;
        int opacity = 100;  // %
        boolean pulse;      // a transition is running
        int bars = -1;      // signal bars 0-4, -1 = hidden

        boolean same(Look o) {
            return o != null && color == o.color && widthPx == o.widthPx && eq(label, o.label) && lost == o.lost
                    && style == o.style && sides == o.sides && opacity == o.opacity && pulse == o.pulse && bars == o.bars;
        }
    }

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint text = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint big = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF box = new RectF();
    private final float d;
    private Look look = new Look();
    private String message;
    private int messageColor;
    private long messageUntil;

    BorderView(Context c) {
        super(c);
        d = getResources().getDisplayMetrics().density;
        text.setColor(Color.WHITE);
        text.setFakeBoldText(true);
        text.setTextSize(14 * d);
        big.setColor(Color.WHITE);
        big.setFakeBoldText(true);
        big.setTextSize(17 * d);
    }

    void show(Look l) {
        if (look.same(l)) return;
        look = l;
        invalidate();
    }

    /** a short message in the middle of the top of the screen, gone after ms */
    void message(String s, int color, long ms) {
        message = s;
        messageColor = color;
        messageUntil = SystemClock.uptimeMillis() + ms;
        invalidate();
        postInvalidateDelayed(ms + 50);
    }

    private static boolean eq(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }

    @Override
    protected void onDraw(Canvas c) {
        int w = getWidth(), h = getHeight(), b = look.widthPx;
        long now = SystemClock.uptimeMillis();
        int alpha = Math.round(255 * Math.max(20, Math.min(100, look.opacity)) / 100f);
        if (look.color != 0) {
            int a = alpha;
            if (look.pulse) {
                // fades between full and about a third, a bit faster than once a second
                double phase = (now % 700) / 700.0;
                a = Math.round(alpha * (0.3f + 0.7f * (float) (0.5 + 0.5 * Math.cos(phase * 2 * Math.PI))));
                postInvalidateOnAnimation();
            }
            paint.setColor(look.color);
            paint.setAlpha(a);
            frame(c, w, h, b);
        }
        if (look.label != null) {
            // the label pill keeps the border colour (orange when there is no border, e.g. the test)
            paint.setColor(look.color != 0 ? look.color : ORANGE);
            paint.setAlpha(Math.max(alpha, 180));
            float pad = 6 * d;
            float tw = text.measureText(look.label);
            float th = text.getTextSize();
            boolean bottom = look.sides == BOTTOM;
            float top = bottom ? h - b - th - pad * 1.5f : (look.sides & TOP) != 0 ? b : 0;
            c.drawRect(w / 2f - tw / 2 - pad, top, w / 2f + tw / 2 + pad, top + th + pad * 1.5f, paint);
            c.drawText(look.label, w / 2f - tw / 2, top + th + pad * 0.5f, text);
        }
        if (look.lost) {
            float r = 6 * d;
            paint.setColor(ORANGE);
            paint.setAlpha(255);
            c.drawCircle(r * 2, r * 2, r, paint);
        } else if (look.bars >= 0) {
            bars(c, look.bars);
        }
        if (message != null && now < messageUntil) {
            float pad = 10 * d;
            float tw = big.measureText(message);
            float th = big.getTextSize();
            float top = h * 0.16f;
            box.set(w / 2f - tw / 2 - pad, top, w / 2f + tw / 2 + pad, top + th + pad * 1.4f);
            paint.setColor(messageColor);
            paint.setAlpha(235);
            c.drawRoundRect(box, 10 * d, 10 * d, paint);
            c.drawText(message, w / 2f - tw / 2, top + th + pad * 0.4f, big);
        }
    }

    /** the border itself, in the chosen style, on the chosen sides */
    private void frame(Canvas c, int w, int h, int b) {
        int s = look.sides;
        boolean top = (s & TOP) != 0, bottom = (s & BOTTOM) != 0, left = (s & LEFT) != 0, right = (s & RIGHT) != 0;
        if (look.style == STYLE_CORNERS) {
            float len = Math.max(36 * d, Math.min(w, h) * 0.14f);
            if (top) {
                c.drawRect(0, 0, len, b, paint);
                c.drawRect(w - len, 0, w, b, paint);
            }
            if (bottom) {
                c.drawRect(0, h - b, len, h, paint);
                c.drawRect(w - len, h - b, w, h, paint);
            }
            if (left) {
                c.drawRect(0, 0, b, len, paint);
                c.drawRect(0, h - len, b, h, paint);
            }
            if (right) {
                c.drawRect(w - b, 0, w, len, paint);
                c.drawRect(w - b, h - len, w, h, paint);
            }
        } else if (look.style == STYLE_DASHED) {
            float dash = Math.max(22 * d, b * 3f), gap = dash * 0.6f;
            for (float x = 0; x < w; x += dash + gap) {
                if (top) c.drawRect(x, 0, Math.min(x + dash, w), b, paint);
                if (bottom) c.drawRect(x, h - b, Math.min(x + dash, w), h, paint);
            }
            for (float y = 0; y < h; y += dash + gap) {
                if (left) c.drawRect(0, y, b, Math.min(y + dash, h), paint);
                if (right) c.drawRect(w - b, y, w, Math.min(y + dash, h), paint);
            }
        } else {
            if (top) c.drawRect(0, 0, w, b, paint);
            if (bottom) c.drawRect(0, h - b, w, h, paint);
            if (left) c.drawRect(0, 0, b, h, paint);
            if (right) c.drawRect(w - b, 0, w, h, paint);
        }
    }

    /** four small signal bars on a dark pill in the top-left corner */
    private void bars(Canvas c, int n) {
        float x0 = 6 * d, y0 = 6 * d, bw = 3.5f * d, step = 5.5f * d, pad = 4 * d, tall = 13 * d;
        box.set(x0, y0, x0 + pad * 2 + step * 3 + bw, y0 + pad * 2 + tall);
        paint.setColor(Color.BLACK);
        paint.setAlpha(150);
        c.drawRoundRect(box, 4 * d, 4 * d, paint);
        int on = n >= 3 ? GREEN : n == 2 ? YELLOW : RED;
        for (int i = 0; i < 4; i++) {
            float bh = tall * (i + 1) / 4f;
            float x = x0 + pad + i * step;
            paint.setColor(i < n ? on : Color.GRAY);
            paint.setAlpha(i < n ? 255 : 110);
            c.drawRect(x, y0 + pad + tall - bh, x + bw, y0 + pad + tall, paint);
        }
    }
}
