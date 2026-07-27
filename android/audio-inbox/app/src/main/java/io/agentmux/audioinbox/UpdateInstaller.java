package io.agentmux.audioinbox;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

import java.io.File;

/** Verified APK handoff through Android's confirmation-preserving installer. */
final class UpdateInstaller {
    private UpdateInstaller() {}

    static void install(Context context, File apk) throws Exception {
        PackageInstaller installer = context.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params =
            new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(context.getPackageName());
        int sessionId = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(sessionId)) {
            try (java.io.InputStream input = new java.io.FileInputStream(apk);
                 java.io.OutputStream output = session.openWrite("update.apk", 0, apk.length())) {
                input.transferTo(output);
                session.fsync(output);
            }
            Intent result = new Intent(context, UpdateInstallReceiver.class);
            result.setAction(context.getPackageName() + ".UPDATE_INSTALL_RESULT");
            PendingIntent pending = PendingIntent.getBroadcast(
                context,
                sessionId,
                result,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE
            );
            session.commit(pending.getIntentSender());
        }
    }
}
