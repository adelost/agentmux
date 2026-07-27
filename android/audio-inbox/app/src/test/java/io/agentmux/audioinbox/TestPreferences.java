package io.agentmux.audioinbox;

import android.content.SharedPreferences;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/** Map-backed preferences for focused local JVM tests. */
final class TestPreferences implements SharedPreferences {
    final Map<String, Object> data = new HashMap<>();
    public Map<String, ?> getAll() { return data; }
    public String getString(String key, String fallback) {
        Object value = data.get(key);
        return value instanceof String ? (String) value : fallback;
    }
    public Set<String> getStringSet(String key, Set<String> fallback) { return fallback; }
    public int getInt(String key, int fallback) { return fallback; }
    public long getLong(String key, long fallback) {
        Object value = data.get(key);
        return value instanceof Long ? (Long) value : fallback;
    }
    public float getFloat(String key, float fallback) { return fallback; }
    public boolean getBoolean(String key, boolean fallback) {
        Object value = data.get(key);
        return value instanceof Boolean ? (Boolean) value : fallback;
    }
    public boolean contains(String key) { return data.containsKey(key); }
    public Editor edit() { return new TestEditor(); }
    public void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) {}
    public void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) {}

    final class TestEditor implements Editor {
        public Editor putString(String key, String value) { data.put(key, value); return this; }
        public Editor putStringSet(String key, Set<String> value) { data.put(key, value); return this; }
        public Editor putInt(String key, int value) { data.put(key, value); return this; }
        public Editor putLong(String key, long value) { data.put(key, value); return this; }
        public Editor putFloat(String key, float value) { data.put(key, value); return this; }
        public Editor putBoolean(String key, boolean value) { data.put(key, value); return this; }
        public Editor remove(String key) { data.remove(key); return this; }
        public Editor clear() { data.clear(); return this; }
        public boolean commit() { return true; }
        public void apply() {}
    }
}
