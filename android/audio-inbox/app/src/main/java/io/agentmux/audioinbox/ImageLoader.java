package io.agentmux.audioinbox;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import android.util.LruCache;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Bounded async image fetch with a small in-memory bitmap cache. */
final class ImageLoader {
    interface Callback {
        void onBitmap(Bitmap bitmap);
        void onError();
    }

    private static final LruCache<String, Bitmap> CACHE = new LruCache<String, Bitmap>(12 * 1024 * 1024) {
        @Override
        protected int sizeOf(String key, Bitmap value) {
            return value.getByteCount();
        }
    };

    private final ExecutorService work = Executors.newFixedThreadPool(2);
    private final Handler main = new Handler(Looper.getMainLooper());

    void close() {
        work.shutdownNow();
    }

    void load(String url, int maxWidthPx, Callback callback) {
        Bitmap cached = CACHE.get(url);
        if (cached != null) {
            callback.onBitmap(cached);
            return;
        }
        work.execute(() -> {
            try {
                Bitmap bitmap = fetch(url, maxWidthPx);
                if (bitmap == null) throw new IllegalStateException("empty image");
                CACHE.put(url, bitmap);
                main.post(() -> callback.onBitmap(bitmap));
            } catch (Exception error) {
                main.post(callback::onError);
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
            BitmapFactory.Options decode = new BitmapFactory.Options();
            decode.inSampleSize = Math.max(1, bounds.outWidth / Math.max(1, maxWidthPx));
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
