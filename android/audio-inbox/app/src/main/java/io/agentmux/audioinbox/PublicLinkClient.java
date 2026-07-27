package io.agentmux.audioinbox;

import org.json.JSONArray;
import org.json.JSONObject;

import io.agentmux.linkcore.VoiceUploadPolicy;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;

/** HTTP client for the public Agentmux Link mailbox (docs/link-internet-v1.md). */
final class PublicLinkClient implements PublicConversationTransport.Client {
    static final String DEFAULT_BASE = "https://link.v1d.io";
    static final int MAX_VOICE_BYTES = (int) VoiceUploadPolicy.PUBLIC_MAX_BYTES;

    static final class LinkTarget {
        final String id;
        final String label;
        final boolean online;

        LinkTarget(String id, String label, boolean online) {
            this.id = id;
            this.label = label;
            this.online = online;
        }
    }

    static final class LinkEvent {
        final long seq;
        final String clientMessageId;
        final String target;
        final String state;
        final String body;
        final String replyBody;

        LinkEvent(long seq, String clientMessageId, String target, String state, String body, String replyBody) {
            this.seq = seq;
            this.clientMessageId = clientMessageId;
            this.target = target;
            this.state = state;
            this.body = body;
            this.replyBody = replyBody;
        }
    }

    static final class EventsPage {
        final List<LinkEvent> events;
        final JSONObject heartbeats;

        EventsPage(List<LinkEvent> events, JSONObject heartbeats) {
            this.events = events;
            this.heartbeats = heartbeats;
        }
    }

    private final String baseUrl;
    private final String session;

    PublicLinkClient(String baseUrl, String session) {
        this.baseUrl = (baseUrl == null || baseUrl.isBlank() ? DEFAULT_BASE : baseUrl).replaceAll("/+$", "");
        this.session = session;
    }

    static String generateVerifier() {
        byte[] raw = new byte[48];
        new SecureRandom().nextBytes(raw);
        StringBuilder value = new StringBuilder();
        for (byte b : raw) value.append((char) ('a' + (b & 0xFF) % 26));
        return value.toString();
    }

    static String pkceChallenge(String verifier) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(verifier.getBytes(StandardCharsets.UTF_8));
            // Exactly base64url without padding, matching the worker's S256.
            return android.util.Base64.encodeToString(hash, android.util.Base64.NO_WRAP | android.util.Base64.URL_SAFE)
                .replace("=", "");
        } catch (Exception error) {
            throw new IllegalStateException("pkce challenge failed", error);
        }
    }

    static String authStartUrl(String baseUrl, String challenge) {
        return (baseUrl == null || baseUrl.isBlank() ? DEFAULT_BASE : baseUrl).replaceAll("/+$", "")
            + "/auth/start?client=android&challenge=" + challenge;
    }

    static String exchange(String baseUrl, String code, String verifier) throws Exception {
        JSONObject response = new JSONObject(request("POST",
            (baseUrl == null || baseUrl.isBlank() ? DEFAULT_BASE : baseUrl).replaceAll("/+$", "") + "/auth/exchange",
            null,
            new JSONObject().put("code", code).put("verifier", verifier).toString()));
        String session = response.optString("session", "");
        if (session.isEmpty()) throw new IllegalStateException("exchange returned no session");
        return session;
    }

    List<LinkTarget> targets() throws Exception {
        JSONObject response = new JSONObject(request("GET", baseUrl + "/api/link/targets", session, null));
        JSONArray rows = response.optJSONArray("targets");
        List<LinkTarget> targets = new ArrayList<>();
        for (int index = 0; rows != null && index < rows.length(); index++) {
            JSONObject row = rows.optJSONObject(index);
            if (row == null) continue;
            targets.add(new LinkTarget(
                row.optString("id"),
                row.optString("label", row.optString("id")),
                row.optBoolean("online", false)
            ));
        }
        return targets;
    }

    @Override
    public String send(String clientMessageId, String target, String text) throws Exception {
        return enqueue(new JSONObject()
            .put("clientMessageId", clientMessageId)
            .put("target", target)
            .put("kind", "text")
            .put("text", text));
    }

    @Override
    public String sendVoice(String clientMessageId, String target, File audio) throws Exception {
        if (audio == null || audio.length() > MAX_VOICE_BYTES) {
            throw new IllegalArgumentException(VoiceUploadPolicy.OVER_LIMIT_MESSAGE);
        }
        byte[] bytes;
        try (InputStream input = new FileInputStream(audio)) {
            bytes = readBounded(input, MAX_VOICE_BYTES);
        }
        JSONObject uploaded = new JSONObject(request(
            "POST",
            baseUrl + "/api/link/voice/upload",
            session,
            new JSONObject()
                .put("audio", android.util.Base64.encodeToString(
                    bytes,
                    android.util.Base64.NO_WRAP
                ))
                .toString()
        ));
        String voiceRef = uploaded.optString("voiceRef", "");
        if (voiceRef.isBlank()) throw new IllegalStateException("voice upload returned no reference");
        return enqueue(new JSONObject()
            .put("clientMessageId", clientMessageId)
            .put("target", target)
            .put("kind", "voice")
            .put("voiceRef", voiceRef));
    }

    private String enqueue(JSONObject payload) throws Exception {
        JSONObject response = new JSONObject(request("POST", baseUrl + "/api/link/send", session,
            payload.toString()));
        return response.optString("state", "queued");
    }

    EventsPage events(long afterSeq) throws Exception {
        JSONObject response = new JSONObject(request("GET", baseUrl + "/api/link/events?after=" + afterSeq, session, null));
        JSONArray rows = response.optJSONArray("events");
        List<LinkEvent> events = new ArrayList<>();
        for (int index = 0; rows != null && index < rows.length(); index++) {
            JSONObject row = rows.optJSONObject(index);
            if (row == null) continue;
            events.add(new LinkEvent(
                row.optLong("seq"),
                row.optString("clientMessageId"),
                row.optString("target"),
                row.optString("state"),
                row.optString("body"),
                row.optString("replyBody")
            ));
        }
        return new EventsPage(events, response.optJSONObject("heartbeats"));
    }

    void revoke() {
        try {
            request("POST", baseUrl + "/auth/revoke", session, null);
        } catch (Exception ignored) {
            // Revocation is best-effort; the session expires regardless.
        }
    }

    /** Polls the events feed until one message is replied, failed, or the bound passes. */
    @Override
    public String awaitReply(String clientMessageId, long timeoutMs) throws Exception {
        long afterSeq = 0;
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            EventsPage page = events(afterSeq);
            for (LinkEvent event : page.events) {
                afterSeq = Math.max(afterSeq, event.seq);
                if (!clientMessageId.equals(event.clientMessageId)) continue;
                if ("replied".equals(event.state)) return event.replyBody;
                if ("failed".equals(event.state)) {
                    throw new IllegalStateException("delivery failed: " + event.replyBody);
                }
            }
            Thread.sleep(2_000);
        }
        throw new IllegalStateException("reply-timeout");
    }

    private static String request(String method, String url, String session, String body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setRequestMethod(method);
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(30_000);
            if (session != null) connection.setRequestProperty("Authorization", "Bearer " + session);
            if (body != null) {
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setDoOutput(true);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(body.getBytes(StandardCharsets.UTF_8));
                }
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            String response = stream == null ? "" : new String(readBounded(stream, 128 * 1024), StandardCharsets.UTF_8);
            if (status < 200 || status >= 300) {
                String error = response.isBlank() ? "http-" + status : response;
                throw new IllegalStateException(error.length() > 200 ? error.substring(0, 200) : error);
            }
            return response;
        } finally {
            connection.disconnect();
        }
    }

    private static byte[] readBounded(InputStream input, int maxBytes) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > maxBytes) throw new IllegalStateException("response oversized");
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }
}
