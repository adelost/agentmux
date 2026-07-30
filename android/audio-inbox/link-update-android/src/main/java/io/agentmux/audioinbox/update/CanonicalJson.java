package io.agentmux.audioinbox.update;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Canonical JSON parity with link/scripts/publish-release.mjs. */
final class CanonicalJson {
    private CanonicalJson() {}

    static String encode(Object value) {
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof JSONObject object) {
            List<String> keys = new ArrayList<>();
            object.keys().forEachRemaining(keys::add);
            keys.sort(String::compareTo);
            List<String> fields = new ArrayList<>();
            for (String key : keys) {
                fields.add(quote(key) + ":" + encode(object.opt(key)));
            }
            return "{" + String.join(",", fields) + "}";
        }
        if (value instanceof JSONArray array) {
            List<String> values = new ArrayList<>();
            for (int index = 0; index < array.length(); index++) {
                values.add(encode(array.opt(index)));
            }
            return "[" + String.join(",", values) + "]";
        }
        if (value instanceof String text) return quote(text);
        if (value instanceof Boolean || value instanceof Integer || value instanceof Long) {
            return String.valueOf(value);
        }
        throw new IllegalArgumentException("unsupported canonical JSON value");
    }

    /**
     * Encodes a JSON string without delegating to Android's JSONObject.quote.
     *
     * Android escapes every slash while the desktop org.json used in tests
     * does not. A release signature must be byte-identical on both runtimes,
     * so this small RFC 8259 encoder owns that boundary explicitly.
     */
    private static String quote(String value) {
        StringBuilder out = new StringBuilder(value.length() + 2).append('"');
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            switch (current) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '/' -> out.append("\\/");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (current <= 0x1f) {
                        out.append(String.format("\\u%04x", (int) current));
                    } else {
                        out.append(current);
                    }
                }
            }
        }
        return out.append('"').toString();
    }
}
