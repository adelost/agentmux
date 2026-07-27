package io.agentmux.audioinbox;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/** HTTPS-only, byte-bounded and digest-pinned APK downloader. */
final class SecureUpdateDownloader {
    interface Progress {
        void onProgress(float value);
    }

    private SecureUpdateDownloader() {}

    static File download(Context context, ReleaseCandidate candidate, Progress progress)
        throws Exception {
        File root = context.getExternalCacheDir() == null
            ? context.getCacheDir()
            : context.getExternalCacheDir();
        File output = new File(root, "agentmux-link-update.apk");
        File temporary = new File(root, "agentmux-link-update.apk.tmp");
        temporary.delete();
        HttpURLConnection connection =
            (HttpURLConnection) new URL(candidate.apkUrl()).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(60_000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
        try {
            if (connection.getResponseCode() != 200) {
                throw new IllegalStateException("update download HTTP " + connection.getResponseCode());
            }
            long declared = connection.getContentLengthLong();
            if (declared > 0 && declared != candidate.sizeBytes()) {
                throw new SecurityException("update content length mismatch");
            }
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long bytes = 0;
            try (InputStream input = connection.getInputStream();
                 FileOutputStream file = new FileOutputStream(temporary)) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    bytes += count;
                    if (bytes > candidate.sizeBytes()) {
                        throw new SecurityException("update size mismatch");
                    }
                    file.write(buffer, 0, count);
                    digest.update(buffer, 0, count);
                    progress.onProgress(Math.min(1f, (float) bytes / candidate.sizeBytes()));
                }
                file.getFD().sync();
            }
            if (bytes != candidate.sizeBytes()
                || !hex(digest.digest()).equals(candidate.sha256())) {
                throw new SecurityException("update payload verification failed");
            }
            if (output.exists() && !output.delete()) {
                throw new IllegalStateException("old update cache is busy");
            }
            if (!temporary.renameTo(output)) {
                throw new IllegalStateException("could not store verified update");
            }
            progress.onProgress(1f);
            return output;
        } catch (Exception error) {
            temporary.delete();
            throw error;
        } finally {
            connection.disconnect();
        }
    }

    static boolean verifyFile(File file, ReleaseCandidate candidate) {
        if (!file.isFile() || file.length() != candidate.sizeBytes()) return false;
        try (InputStream input = new java.io.FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
            return hex(digest.digest()).equals(candidate.sha256());
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder();
        for (byte item : bytes) value.append(String.format("%02x", item));
        return value.toString();
    }
}
