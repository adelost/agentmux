package io.agentmux.audioinbox;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import java.util.ArrayDeque;

final class AudioInboxStore {
    private final Context context;
    private final SharedPreferences preferences;

    AudioInboxStore(Context context, SharedPreferences preferences) {
        this.context = context;
        this.preferences = preferences;
    }

    void saveLocalState(String eventId, String state) {
        preferences.edit().putString("event-state:" + eventId, state).apply();
    }

    String localState(String eventId) {
        return preferences.getString("event-state:" + eventId, "");
    }

    void saveCurrent(String text, long createdAt) {
        preferences.edit()
            .putString(AppContract.KEY_CURRENT, text)
            .putLong(AppContract.KEY_CURRENT_CREATED_AT, createdAt)
            .apply();
        broadcastStatus();
    }

    void saveHistory(String line) {
        String existing = preferences.getString(AppContract.KEY_HISTORY, "");
        ArrayDeque<String> rows = new ArrayDeque<>();
        rows.add(line);
        if (existing != null) {
            for (String row : existing.split("\n")) {
                if (!row.isBlank() && rows.size() < 5) rows.add(row);
            }
        }
        preferences.edit().putString(AppContract.KEY_HISTORY, String.join("\n", rows)).apply();
        broadcastStatus();
    }

    void updateConnection(String state, boolean connected) {
        SharedPreferences.Editor edit = preferences.edit()
            .putString(AppContract.KEY_CONNECTION, state);
        if (connected) edit.putLong(AppContract.KEY_CONNECTED_AT, System.currentTimeMillis());
        edit.apply();
        broadcastStatus();
    }

    private void broadcastStatus() {
        Intent status = new Intent(AppContract.ACTION_STATUS);
        status.setPackage(context.getPackageName());
        context.sendBroadcast(status);
    }
}
