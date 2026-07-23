package io.agentmux.audioinbox;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import android.util.LruCache;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Bounded async image fetch: 8 MiB compressed cap, a decoded pixel budget
 * on both dimensions, in-flight dedupe per URL, and a generation fence so
 * stale work never calls back after close. Small in-memory bitmap cache.
 */
final class ImageLoader {
    interface Callback {
        void onBitmap(Bitmap bitmap);
        void onError();
    }

    private static final int MAX_DECODED_PIXELS = 4_000_000;

    private final LruCache<String, Bitmap> cache = new LruCache<String, Bitmap>(12 * 1024 * 1024) {
        @Override
        protected int sizeOf(String key, Bitmap value) {
            return value.getByteCount();
        }
    };

    private final Map<String, List<Callback>> inFlight = new HashMap<>();
    private final ExecutorService work = Executors.newFixedThreadPool(2);
    private final Handler main = new Handler(Looper.getMainLooper());
    private int generation;
    private boolean closed;

    void close() {
        closed = true;
        generation += 1;
        work.shutdownNow();
    }

    void load(String url, int maxWidthPx, Callback callback) {
        Bitmap cached = cache.get(url);
        if (cached != null) {
            callback.onBitmap(cached);
            return;
        }
        synchronized (inFlight) {
            if (closed) return;
            // Fanout dedupe: every caller is registered and always answered.
            List<Callback> waiters = inFlight.get(url);
            if (waiters != null) {
                waiters.add(callback);
                return;
            }
            waiters = new ArrayList<>();
            waiters.add(callback);
            inFlight.put(url, waiters);
        }
        final int expected = generation;
        work.execute(() -> {
            try {
                Bitmap bitmap = fetch(url, maxWidthPx);
                if (bitmap == null) throw new IllegalStateException("empty image");
                cache.put(url, bitmap);
                finish(url, expected, true, bitmap);
            } catch (Exception error) {
                finish(url, expected, false, null);
            }
        });
    }

    private void finish(String url, int expected, boolean ok, Bitmap bitmap) {
        main.post(() -> {
            List<Callback> waiters;
            synchronized (inFlight) {
                waiters = inFlight.remove(url);
            }
            if (closed || expected != generation || waiters == null) return;
            for (Callback callback : waiters) {
                if (ok) callback.onBitmap(bitmap);
                else callback.onError();
            }
        });
    }

    private static Bitmap fetch(String url, int maxWidthPx) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setConnectTimeout(8_000);
            connection.setReadTimeout(15_000);
            if (connection.getResponseCode() != 200) return null;
            byte[] bytes;
            try (InputStream input = connection.getInputStream()) {
                bytes = readBounded(input, MessageMedia.MAX_IMAGE_BYTES);
            }
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
            int sample = 1;
            // Test the CURRENT sample: the decoded bitmap must fit the pixel
            // budget and the target width before the loop may stop.
            while ((bounds.outWidth / sample) * (long) (bounds.outHeight / sample) > MAX_DECODED_PIXELS
                || bounds.outWidth / sample > maxWidthPx) {
                sample *= 2;
            }
            BitmapFactory.Options decode = new BitmapFactory.Options();
            decode.inSampleSize = sample;
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, decode);
        } finally {
            connection.disconnect();
        }
    }

    private static byte[] readBounded(InputStream input, int maxBytes) throws Exception {
        java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > maxBytes) throw new IllegalStateException("image exceeds 8 MiB");
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }
}
