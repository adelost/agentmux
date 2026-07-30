package io.agentmux.audioinbox;

import org.json.JSONArray;
import org.json.JSONObject;

import io.agentmux.linkcore.VoiceUploadPolicy;
import io.agentmux.linkcore.LinkMailboxEvent;

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
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.List;

/** HTTP client for the public Agentmux Link mailbox (docs/link-internet-v1.md). */
public final class PublicLinkClient implements PublicConversationTransport.Client {
    public static final String DEFAULT_BASE = "https://link.v1d.io";
    public static final int MAX_VOICE_BYTES = (int) VoiceUploadPolicy.PUBLIC_MAX_BYTES;

    public static final class LinkTarget {
        public final String id;
        public final String label;
        public final boolean online;

        LinkTarget(String id, String label, boolean online) {
            this.id = id;
            this.label = label;
            this.online = online;
        }
    }

    public static final class TargetCatalog {
        public final List<LinkTarget> targets;
        public final List<String> privateDiscoveryUrls;

        TargetCatalog(List<LinkTarget> targets, List<String> privateDiscoveryUrls) {
            this.targets = targets;
            this.privateDiscoveryUrls = privateDiscoveryUrls;
        }
    }

    public static final class LinkEvent {
        public final long seq;
        public final String clientMessageId;
        public final String target;
        public final String state;
        public final String body;
        public final String replyBody;
        public final String lastError;
        public final long createdAtMs;
        public final long replyAtMs;

        LinkEvent(
            long seq,
            String clientMessageId,
            String target,
            String state,
            String body,
            String replyBody,
            String lastError,
            long createdAtMs,
            long replyAtMs
        ) {
            this.seq = seq;
            this.clientMessageId = clientMessageId;
            this.target = target;
            this.state = state;
            this.body = body;
            this.replyBody = replyBody;
            this.lastError = lastError;
            this.createdAtMs = createdAtMs;
            this.replyAtMs = replyAtMs;
        }

        public LinkMailboxEvent asDomainEvent() {
            return new LinkMailboxEvent(
                seq,
                clientMessageId,
                target,
                state,
                body,
                replyBody,
                lastError,
                createdAtMs,
                replyAtMs
            );
        }
    }

    public static final class EventsPage {
        public final List<LinkEvent> events;
        public final Map<String, Boolean> heartbeats;

        EventsPage(List<LinkEvent> events, Map<String, Boolean> heartbeats) {
            this.events = events;
            this.heartbeats = heartbeats;
        }
    }

    private final String baseUrl;
    private final String session;

    public PublicLinkClient(String baseUrl, String session) {
        this.baseUrl = (baseUrl == null || baseUrl.isBlank() ? DEFAULT_BASE : baseUrl).replaceAll("/+$", "");
        this.session = session;
    }

    public static String generateVerifier() {
        byte[] raw = new byte[48];
        new SecureRandom().nextBytes(raw);
        StringBuilder value = new StringBuilder();
        for (byte b : raw) value.append((char) ('a' + (b & 0xFF) % 26));
        return value.toString();
    }

    public static String pkceChallenge(String verifier) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(verifier.getBytes(StandardCharsets.UTF_8));
            // Exactly base64url without padding, matching the worker's S256.
            return Base64.getUrlEncoder().withoutPadding().encodeToString(hash);
        } catch (Exception error) {
            throw new IllegalStateException("pkce challenge failed", error);
        }
    }

    public static String authStartUrl(String baseUrl, String challenge) {
        return (baseUrl == null || baseUrl.isBlank() ? DEFAULT_BASE : baseUrl).replaceAll("/+$", "")
            + "/auth/start?client=android&challenge=" + challenge;
    }

    public static LinkSessionCredentials exchange(
        String baseUrl,
        String code,
        String verifier
    ) throws Exception {
        JSONObject response = new JSONObject(request("POST",
            (baseUrl == null || baseUrl.isBlank() ? DEFAULT_BASE : baseUrl).replaceAll("/+$", "") + "/auth/exchange",
            null,
            new JSONObject().put("code", code).put("verifier", verifier).toString()));
        String session = response.optString("session", "");
        if (session.isEmpty()) throw new IllegalStateException("exchange returned no session");
        return new LinkSessionCredentials(
            baseUrl,
            session,
            response.optString("identityId", "")
        );
    }

    public TargetCatalog targetCatalog() throws Exception {
        return parseTargetCatalog(request("GET", baseUrl + "/api/link/targets", session, null));
    }

    /** Reads non-secret private transport hints before the user needs a mailbox session. */
    public static List<String> publishedPrivateDiscoveryUrls(String baseUrl) throws Exception {
        String root = (baseUrl == null || baseUrl.isBlank() ? DEFAULT_BASE : baseUrl)
            .replaceAll("/+$", "");
        return parseTargetCatalog(request(
            "GET",
            root + "/api/link/discovery",
            null,
            null
        )).privateDiscoveryUrls;
    }

    public static TargetCatalog parseTargetCatalog(String raw) throws Exception {
        JSONObject response = new JSONObject(raw);
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
        JSONArray discoveryRows = response.optJSONArray("privateDiscoveryUrls");
        List<String> privateDiscoveryUrls = new ArrayList<>();
        for (int index = 0; discoveryRows != null && index < discoveryRows.length(); index++) {
            String candidate = discoveryRows.optString(index, "").trim().replaceAll("/+$", "");
            if (LinkUrlPolicy.isAllowedServer(candidate)
                && !privateDiscoveryUrls.contains(candidate)
                && privateDiscoveryUrls.size() < 8) {
                privateDiscoveryUrls.add(candidate);
            }
        }
        return new TargetCatalog(List.copyOf(targets), List.copyOf(privateDiscoveryUrls));
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
                .put("audio", Base64.getEncoder().encodeToString(bytes))
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

    public EventsPage events(long afterSeq) throws Exception {
        return parseEventsPage(request(
            "GET",
            baseUrl + "/api/link/events?after=" + afterSeq,
            session,
            null
        ));
    }

    static EventsPage parseEventsPage(String json) {
        JSONObject response = new JSONObject(json);
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
                row.optString("replyBody"),
                row.optString("lastError"),
                row.optLong("createdAt"),
                row.optLong("replyAt")
            ));
        }
        JSONObject heartbeatRows = response.optJSONObject("heartbeats");
        Map<String, Boolean> heartbeats = new LinkedHashMap<>();
        if (heartbeatRows != null) {
            for (String target : heartbeatRows.keySet()) {
                heartbeats.put(target, heartbeatRows.optBoolean(target, false));
            }
        }
        return new EventsPage(List.copyOf(events), Map.copyOf(heartbeats));
    }

    public void revoke() {
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
                    String detail = event.lastError.isBlank() ? event.replyBody : event.lastError;
                    throw new IllegalStateException("delivery failed: " + detail);
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
