package io.agentmux.audioinbox;

import android.os.Handler;
import android.os.Looper;

/** Runs UI-owned state changes on the main thread, inline when already there, like Activity.runOnUiThread. */
final class MainThread {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private MainThread() {}

    static void run(Runnable operation) {
        if (Looper.myLooper() == Looper.getMainLooper()) operation.run();
        else MAIN.post(operation);
    }
}
