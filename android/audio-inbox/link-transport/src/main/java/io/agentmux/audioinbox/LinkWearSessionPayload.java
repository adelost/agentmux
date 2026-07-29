package io.agentmux.audioinbox;

import java.util.LinkedHashMap;
import java.util.Map;

/** Versioned, non-logging wire payload for the phone-owned Wear session item. */
public record LinkWearSessionPayload(
    boolean revoked,
    LinkSessionCredentials credentials,
    long changedAtMs
) {
    public static final String PATH = "/link/session";
    public static final String KEY_VERSION = "version";
    public static final String KEY_REVOKED = "revoked";
    public static final String KEY_BASE_URL = "baseUrl";
    public static final String KEY_SESSION = "session";
    public static final String KEY_IDENTITY_ID = "identityId";
    public static final String KEY_CHANGED_AT_MS = "changedAtMs";
    public static final int VERSION = 1;

    public LinkWearSessionPayload {
        if (!revoked && credentials == null) {
            throw new IllegalArgumentException("active handoff requires credentials");
        }
        if (changedAtMs <= 0) throw new IllegalArgumentException("change time required");
    }

    public static LinkWearSessionPayload active(
        LinkSessionCredentials credentials,
        long changedAtMs
    ) {
        return new LinkWearSessionPayload(false, credentials, changedAtMs);
    }

    public static LinkWearSessionPayload revoked(long changedAtMs) {
        return new LinkWearSessionPayload(true, null, changedAtMs);
    }

    public Map<String, String> encode() {
        Map<String, String> values = new LinkedHashMap<>();
        values.put(KEY_VERSION, String.valueOf(VERSION));
        values.put(KEY_REVOKED, String.valueOf(revoked));
        values.put(KEY_CHANGED_AT_MS, String.valueOf(changedAtMs));
        if (credentials != null) {
            values.put(KEY_BASE_URL, credentials.baseUrl());
            values.put(KEY_SESSION, credentials.session());
            values.put(KEY_IDENTITY_ID, credentials.identityId());
        }
        return Map.copyOf(values);
    }

    public static LinkWearSessionPayload decode(Map<String, String> values) {
        if (values == null || parseLong(values.get(KEY_VERSION)) != VERSION) return null;
        long changedAtMs = parseLong(values.get(KEY_CHANGED_AT_MS));
        if (changedAtMs <= 0) return null;
        if (Boolean.parseBoolean(values.get(KEY_REVOKED))) return revoked(changedAtMs);
        try {
            return active(
                new LinkSessionCredentials(
                    values.get(KEY_BASE_URL),
                    values.get(KEY_SESSION),
                    values.get(KEY_IDENTITY_ID)
                ),
                changedAtMs
            );
        } catch (RuntimeException invalid) {
            return null;
        }
    }

    private static long parseLong(String value) {
        try {
            return Long.parseLong(value == null ? "" : value);
        } catch (NumberFormatException ignored) {
            return -1;
        }
    }
}
