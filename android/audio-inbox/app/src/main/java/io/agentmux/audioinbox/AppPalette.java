package io.agentmux.audioinbox;

import android.content.res.ColorStateList;
import android.graphics.Color;
import android.widget.Switch;

final class AppPalette {
    static final int BACKGROUND = Color.rgb(9, 13, 18);
    static final int SURFACE = Color.rgb(18, 25, 34);
    static final int PRIMARY = Color.rgb(238, 246, 243);
    static final int SECONDARY = Color.rgb(147, 164, 174);
    static final int ACCENT = Color.rgb(109, 227, 181);
    static final int WARNING = Color.rgb(255, 190, 92);
    static final int ERROR = Color.rgb(255, 112, 112);

    private AppPalette() {}

    static void tintSwitch(Switch toggle) {
        int[][] states = new int[][]{
            new int[]{android.R.attr.state_checked},
            new int[]{}
        };
        toggle.setThumbTintList(new ColorStateList(states, new int[]{
            ACCENT,
            Color.rgb(126, 141, 150)
        }));
        toggle.setTrackTintList(new ColorStateList(states, new int[]{
            Color.rgb(54, 115, 92),
            Color.rgb(44, 55, 64)
        }));
    }
}
