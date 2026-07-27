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
    static final String KEY_LINK_STATE_V2 = "linkStateV2";
    static final String KEY_LINK_STATE_V2_QUARANTINE = "linkStateV2Quarantine";
    static final String KEY_UPDATE_READY = "updateReadyV1";
    static final String KEY_UPDATE_INSTALL_STATUS = "updateInstallStatus";
    static final String ACTION_START = "io.agentmux.audioinbox.START";
    static final String ACTION_STOP = "io.agentmux.audioinbox.STOP";
    static final String ACTION_STATUS = "io.agentmux.audioinbox.STATUS";
    static final String ACTION_PLAY_REPLY = "io.agentmux.audioinbox.PLAY_REPLY";
    static final String ACTION_RESUME_AUDIO = "io.agentmux.audioinbox.RESUME_AUDIO";
    static final String ACTION_PAUSE_AUDIO = "io.agentmux.audioinbox.PAUSE_AUDIO";
    static final String ACTION_STOP_AUDIO = "io.agentmux.audioinbox.STOP_AUDIO";
    static final String ACTION_REPLAY_REPLY = "io.agentmux.audioinbox.REPLAY_REPLY";
    static final String EXTRA_TURN_ID = "turnId";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_SERVER = "serverUrl";
    static final String EXTRA_TARGET_LABEL = "targetLabel";

    private AppContract() {}

    static String consumerId(SharedPreferences preferences) {
        String current = preferences.getString(KEY_CONSUMER, "");
        if (current != null && !current.isBlank()) return current;
        String generated = "android-" + UUID.randomUUID();
        preferences.edit().putString(KEY_CONSUMER, generated).apply();
        return generated;
    }
}
