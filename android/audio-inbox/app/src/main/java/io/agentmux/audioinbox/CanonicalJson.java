package io.agentmux.audioinbox;

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
                fields.add(JSONObject.quote(key) + ":" + encode(object.opt(key)));
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
        if (value instanceof String text) return JSONObject.quote(text);
        if (value instanceof Boolean || value instanceof Integer || value instanceof Long) {
            return String.valueOf(value);
        }
        throw new IllegalArgumentException("unsupported canonical JSON value");
    }
}
