package io.agentmux.audioinbox;

import static org.junit.Assert.*;

import android.content.SharedPreferences;

import org.junit.Test;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;

public class ConversationStoreTest {
    /** Minimal map-backed SharedPreferences for JVM tests (no Robolectric). */
    private static final class FakePreferences implements SharedPreferences {
        final Map<String, Object> data = new HashMap<>();
        public Map<String, ?> getAll() { return data; }
        public String getString(String key, String fallback) {
            Object value = data.get(key);
            return value instanceof String ? (String) value : fallback;
        }
        public Set<String> getStringSet(String key, Set<String> fallback) { return fallback; }
        public int getInt(String key, int fallback) { return fallback; }
        public long getLong(String key, long fallback) { return fallback; }
        public float getFloat(String key, float fallback) { return fallback; }
        public boolean getBoolean(String key, boolean fallback) { return fallback; }
        public boolean contains(String key) { return data.containsKey(key); }
        public Editor edit() { return new FakeEditor(); }
        public void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) {}
        public void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) {}

        final class FakeEditor implements Editor {
            public Editor putString(String key, String value) { data.put(key, value); return this; }
            public Editor putStringSet(String key, Set<String> value) { return this; }
            public Editor putInt(String key, int value) { return this; }
            public Editor putLong(String key, long value) { return this; }
            public Editor putFloat(String key, float value) { return this; }
            public Editor putBoolean(String key, boolean value) { return this; }
            public Editor remove(String key) { data.remove(key); return this; }
            public Editor clear() { data.clear(); return this; }
            public boolean commit() { return true; }
            public void apply() {}
        }
    }

    @Test
    public void keepsTheNewestHundredMessages() {
        ConversationStore store = new ConversationStore(new FakePreferences());
        for (int index = 0; index < 120; index++) {
            store.append("user", "L-source 3", "meddelande " + index);
        }
        assertEquals(100, store.read().size());
        assertEquals("meddelande 20", store.read().get(0).text);
        assertEquals("meddelande 119", store.read().get(99).text);
    }

    @Test
    public void damagedCacheNeverBlocksANewConversation() {
        FakePreferences preferences = new FakePreferences();
        preferences.data.put(AppContract.KEY_CONVERSATION, "{trasig");
        ConversationStore store = new ConversationStore(preferences);
        assertTrue(store.read().isEmpty());
        store.append("assistant", "L-source 10", "svar");
        assertEquals(1, store.read().size());
        assertEquals("L-source 10", store.read().get(0).target);
    }
}
