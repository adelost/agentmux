package io.agentmux.audioinbox;

import android.content.SharedPreferences;

import java.util.UUID;

final class AppContract {
    static final String PREFS = "audio-inbox";
    static final String KEY_ENABLED = "handsFree";
    static final String KEY_SERVER = "serverUrl";
    static final String KEY_TARGET = "target";
    static final String KEY_CONSUMER = "consumerId";
    static final String KEY_CONNECTION = "connection";
    static final String KEY_CONNECTED_AT = "connectedAt";
    static final String KEY_CURRENT = "currentText";
    static final String KEY_CURRENT_CREATED_AT = "currentCreatedAt";
    static final String KEY_HISTORY = "history";
    static final String KEY_CONVERSATION = "conversation";
    static final String KEY_CONVERSATION_TARGET = "conversationTarget";
    static final String KEY_SPEAK_REPLIES = "speakReplies";
    static final String ACTION_START = "io.agentmux.audioinbox.START";
    static final String ACTION_STOP = "io.agentmux.audioinbox.STOP";
    static final String ACTION_STATUS = "io.agentmux.audioinbox.STATUS";

    private AppContract() {}

    static String consumerId(SharedPreferences preferences) {
        String current = preferences.getString(KEY_CONSUMER, "");
        if (current != null && !current.isBlank()) return current;
        String generated = "android-" + UUID.randomUUID();
        preferences.edit().putString(KEY_CONSUMER, generated).apply();
        return generated;
    }
}
