package io.agentmux.audioinbox;

import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

final class ConversationStore {
    static final class Message {
        final String role;
        final String target;
        final String text;

        Message(String role, String target, String text) {
            this.role = role;
            this.target = target;
            this.text = text;
        }
    }

    private static final int MAX_MESSAGES = 24;
    private final SharedPreferences preferences;

    ConversationStore(SharedPreferences preferences) {
        this.preferences = preferences;
    }

    synchronized List<Message> append(String role, String target, String text) {
        List<Message> messages = read();
        messages.add(new Message(role, target, text.trim()));
        if (messages.size() > MAX_MESSAGES) {
            messages = new ArrayList<>(messages.subList(messages.size() - MAX_MESSAGES, messages.size()));
        }
        JSONArray json = new JSONArray();
        for (Message message : messages) {
            try {
                json.put(new JSONObject()
                    .put("role", message.role)
                    .put("target", message.target)
                    .put("text", message.text));
            } catch (Exception ignored) {
                // Strings are JSON-safe; keep a corrupt row from blocking the UI anyway.
            }
        }
        preferences.edit().putString(AppContract.KEY_CONVERSATION, json.toString()).apply();
        return messages;
    }

    synchronized List<Message> read() {
        List<Message> messages = new ArrayList<>();
        try {
            JSONArray json = new JSONArray(preferences.getString(AppContract.KEY_CONVERSATION, "[]"));
            for (int index = 0; index < json.length(); index++) {
                JSONObject row = json.optJSONObject(index);
                if (row == null) continue;
                String role = row.optString("role", "");
                String target = row.optString("target", "");
                String text = row.optString("text", "").trim();
                if (("user".equals(role) || "assistant".equals(role)) && !text.isEmpty()) {
                    messages.add(new Message(role, target, text));
                }
            }
        } catch (Exception ignored) {
            // A damaged UI cache must never block a new conversation.
        }
        return messages;
    }
}
