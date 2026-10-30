package com.robfulcher.aoe2companion;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.view.Window;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Wonder Wars: turn the screen sideways or upright from the game, and hide the
 * status and navigation bars while playing sideways (swipe from an edge to see them).
 */
@CapacitorPlugin(name = "Orientation")
public class OrientationPlugin extends Plugin {

    /** mode: "landscape", "portrait", or "auto" (follow the phone, as the rest of the app does). */
    @PluginMethod
    public void set(PluginCall call) {
        String mode = call.getString("mode", "auto");
        int o;
        if ("landscape".equals(mode)) o = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE;
        else if ("portrait".equals(mode)) o = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
        else o = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        Activity a = getActivity();
        a.runOnUiThread(() -> {
            a.setRequestedOrientation(o);
            call.resolve();
        });
    }

    @PluginMethod
    public void immersive(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        Activity a = getActivity();
        a.runOnUiThread(() -> {
            try {
                Window w = a.getWindow();
                WindowInsetsControllerCompat c = WindowCompat.getInsetsController(w, w.getDecorView());
                if (on) {
                    c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                    c.hide(WindowInsetsCompat.Type.systemBars());
                } else {
                    c.show(WindowInsetsCompat.Type.systemBars());
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("Couldn't change the system bars: " + e.getMessage());
            }
        });
    }
}
