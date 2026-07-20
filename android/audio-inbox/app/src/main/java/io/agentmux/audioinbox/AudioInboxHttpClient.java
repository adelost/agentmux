package io.agentmux.audioinbox;

import android.net.Uri;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class AudioInboxHttpClient {
    private static final int MAX_AUDIO_BYTES = 10 * 1024 * 1024;

    private final String serverUrl;
    private final String consumerId;

    AudioInboxHttpClient(String serverUrl, String consumerId) {
        this.serverUrl = serverUrl.replaceAll("/+$", "");
        this.consumerId = consumerId;
    }

    HttpURLConnection openFeed(String target) throws Exception {
        URL url = new URL(serverUrl + "/api/audio/events?consumerId="
            + encode(consumerId) + "&target=" + encode(target) + "&limit=100");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("GET");
        connection.setRequestProperty("Accept", "text/event-stream");
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(20_000);
        if (connection.getResponseCode() != 200) {
            int status = connection.getResponseCode();
            connection.disconnect();
            throw new IllegalStateException("feed HTTP " + status);
        }
        return connection;
    }

    File fetchTts(File cacheDir, String eventId, String text) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(
            serverUrl + "/api/tts"
        ).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(30_000);
            connection.setDoOutput(true);
            byte[] body = new JSONObject()
                .put("text", text)
                .toString()
                .getBytes(StandardCharsets.UTF_8);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }
            if (connection.getResponseCode() != 200) {
                throw new IllegalStateException("tts HTTP " + connection.getResponseCode());
            }
            byte[] audio;
            try (InputStream input = connection.getInputStream()) {
                audio = readBounded(input, MAX_AUDIO_BYTES);
            }
            File file = new File(cacheDir, "audio-" + eventId + ".mp3");
            try (FileOutputStream output = new FileOutputStream(file)) {
                output.write(audio);
            }
            return file;
        } finally {
            connection.disconnect();
        }
    }

    void postReceipt(String eventId, String state, String detail) throws Exception {
        URL url = new URL(serverUrl + "/api/audio/events/"
            + encode(eventId) + "/receipts");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(10_000);
            connection.setDoOutput(true);
            JSONObject body = new JSONObject()
                .put("consumerId", consumerId)
                .put("state", state);
            if (detail != null) body.put("detail", detail);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            if (status != 200 && status != 201) {
                throw new IllegalStateException("receipt " + state + " HTTP " + status);
            }
        } finally {
            connection.disconnect();
        }
    }

    private static String encode(String value) {
        return Uri.encode(value);
    }

    private static byte[] readBounded(InputStream input, int maxBytes) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > maxBytes) {
                throw new IllegalStateException("audio clip exceeds 10 MiB");
            }
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }
}
