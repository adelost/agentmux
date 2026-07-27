package io.agentmux.audioinbox;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/** Owns the reconnecting SSE transport; playback state stays in the service. */
final class AudioFeedLoop implements AutoCloseable {
    interface Listener {
        void onConnected(boolean connected);
        void onEvent(JSONObject event);
        void onError(String detail);
    }

    private final Listener listener;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicInteger generation = new AtomicInteger();
    private volatile boolean enabled;
    private volatile HttpURLConnection active;

    AudioFeedLoop(Listener listener) {
        this.listener = listener;
    }

    void start(AudioInboxHttpClient client, String target) {
        enabled = true;
        int expected = generation.incrementAndGet();
        executor.execute(() -> run(client, target, expected));
    }

    void stop() {
        enabled = false;
        generation.incrementAndGet();
        HttpURLConnection connection = active;
        if (connection != null) connection.disconnect();
        active = null;
    }

    private void run(AudioInboxHttpClient client, String target, int expected) {
        while (enabled && expected == generation.get()) {
            try {
                HttpURLConnection connection = client.openFeed(target);
                active = connection;
                listener.onConnected(true);
                read(connection, expected);
            } catch (Exception error) {
                if (enabled && expected == generation.get()) {
                    listener.onError(error.getMessage());
                }
            } finally {
                active = null;
                listener.onConnected(false);
            }
            if (enabled && expected == generation.get()) {
                try {
                    Thread.sleep(2000);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    private void read(HttpURLConnection connection, int expected) throws Exception {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
            connection.getInputStream(),
            StandardCharsets.UTF_8
        ))) {
            String eventName = "";
            String line;
            while (enabled && expected == generation.get() && (line = reader.readLine()) != null) {
                if (line.startsWith("event:")) {
                    eventName = line.substring("event:".length()).trim();
                } else if (line.startsWith("data:") && "audio".equals(eventName)) {
                    listener.onEvent(new JSONObject(line.substring("data:".length()).trim()));
                } else if (line.isEmpty()) {
                    eventName = "";
                }
            }
        }
    }

    @Override
    public void close() {
        stop();
        executor.shutdownNow();
    }
}
