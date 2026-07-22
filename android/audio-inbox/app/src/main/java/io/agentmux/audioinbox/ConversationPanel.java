package io.agentmux.audioinbox;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Switch;
import android.widget.TextView;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

import static io.agentmux.audioinbox.AppPalette.*;

final class ConversationPanel extends LinearLayout implements AutoCloseable {
    private final Activity activity;
    private final SharedPreferences preferences;
    private final ConversationStore store;
    private final DirectReplySpeaker speaker;
    private final ConversationController controller;
    private final List<ConversationTarget> targets = new ArrayList<>();
    private final Button agentTarget;
    private final Button windowsTarget;
    private final TextView history;
    private final TextView status;
    private final EditText composer;
    private final Button send;
    private final Switch speakReplies;
    private final PushToTalkController pushToTalk;
    private String selectedId;
    private String pendingText;

    ConversationPanel(Activity activity, SharedPreferences preferences) {
        super(activity);
        this.activity = activity;
        this.preferences = preferences;
        store = new ConversationStore(preferences);
        speaker = new DirectReplySpeaker(activity);
        selectedId = preferences.getString(AppContract.KEY_CONVERSATION_TARGET, "lsrc:3");
        setOrientation(VERTICAL);
        setPadding(dp(18), dp(17), dp(18), dp(17));
        setBackground(rounded(SURFACE, 18, Color.rgb(34, 46, 57)));

        LinearLayout heading = new LinearLayout(activity);
        heading.setGravity(Gravity.CENTER_VERTICAL);
        heading.addView(text("Talk to", 19, true, PRIMARY), new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1));
        speakReplies = new Switch(activity);
        speakReplies.setText("Read replies aloud");
        speakReplies.setTextColor(SECONDARY);
        speakReplies.setTextSize(12);
        speakReplies.setChecked(preferences.getBoolean(AppContract.KEY_SPEAK_REPLIES, false));
        tintSwitch(speakReplies);
        speakReplies.setOnCheckedChangeListener((button, checked) -> preferences.edit()
            .putBoolean(AppContract.KEY_SPEAK_REPLIES, checked).apply());
        heading.addView(speakReplies);
        addView(heading);

        LinearLayout favorites = new LinearLayout(activity);
        favorites.setOrientation(HORIZONTAL);
        favorites.setPadding(0, dp(14), 0, 0);
        agentTarget = targetButton("★ L-source 3", "lsrc:3");
        windowsTarget = targetButton("★ Windows rescue", "windows");
        favorites.addView(agentTarget, weightedButton(0));
        favorites.addView(windowsTarget, weightedButton(8));
        addView(favorites);

        history = text("No conversation yet", 15, false, SECONDARY);
        history.setLineSpacing(dp(4), 1f);
        addView(history, margins(18, 14));

        LinearLayout composeRow = new LinearLayout(activity);
        composeRow.setOrientation(HORIZONTAL);
        composeRow.setGravity(Gravity.BOTTOM);
        composer = new EditText(activity);
        composer.setHint("Write a message…");
        composer.setHintTextColor(Color.rgb(107, 126, 137));
        composer.setTextColor(PRIMARY);
        composer.setTextSize(15);
        composer.setMinHeight(dp(48));
        composer.setMaxLines(4);
        composer.setPadding(dp(13), dp(8), dp(13), dp(8));
        composer.setBackground(rounded(BACKGROUND, 12, Color.rgb(41, 54, 65)));
        composer.setImeOptions(EditorInfo.IME_ACTION_SEND);
        composer.setOnEditorActionListener((view, actionId, event) -> {
            if (actionId != EditorInfo.IME_ACTION_SEND) return false;
            sendText();
            return true;
        });
        composeRow.addView(composer, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1));
        send = button("Send", ACCENT, Color.rgb(5, 20, 15));
        send.setOnClickListener(view -> sendText());
        LayoutParams sendParams = new LayoutParams(dp(82), dp(48));
        sendParams.leftMargin = dp(8);
        composeRow.addView(send, sendParams);
        addView(composeRow);

        status = text("Finding your favorites…", 13, false, WARNING);
        addView(status, margins(12, 0));
        Button talk = button("Hold to talk", ACCENT, Color.rgb(5, 20, 15));
        addView(talk, margins(10, 0));

        controller = new ConversationController(
            activity,
            AppContract.consumerId(preferences),
            new ConversationController.Listener() {
                public void onSending() { setBusy(true, "Sending securely over Tailscale…"); }
                public void onTranscript(String value) { acceptTranscript(value); }
                public void onReply(String value) { acceptReply(value); }
                public void onFailure(String value) { fail(value); }
            }
        );
        pushToTalk = new PushToTalkController(activity, talk, status, new PushToTalkController.Environment() {
            public boolean ready() { return selectedTarget() != null && !controller.isBusy(); }
            public boolean send(File audio, String turnId) {
                pendingText = null;
                return controller.sendAudio(selectedTarget(), audio, turnId);
            }
        });
        renderHistory();
        renderTargets();
    }

    void addDiscoveredTargets(List<ConversationTarget> discovered) {
        for (ConversationTarget target : discovered) {
            targets.removeIf(existing -> existing.id.equals(target.id));
            targets.add(target);
        }
        if (selectedTarget() == null && !targets.isEmpty()) selectedId = targets.get(0).id;
        renderTargets();
    }

    private void sendText() {
        ConversationTarget target = selectedTarget();
        String value = composer.getText().toString().trim();
        if (target == null) {
            status.setText("That favorite is offline");
            return;
        }
        if (value.isEmpty() || controller.isBusy()) return;
        pendingText = value;
        if (!controller.sendText(target, value)) return;
        composer.setText("");
        store.append("user", target.label, value);
        renderHistory();
    }

    private void acceptTranscript(String value) {
        if (pendingText == null) {
            ConversationTarget target = selectedTarget();
            store.append("user", target == null ? "Agent" : target.label, value);
            renderHistory();
        }
        pendingText = null;
        status.setText("Message delivered · waiting for reply…");
    }

    private void acceptReply(String value) {
        ConversationTarget target = selectedTarget();
        store.append("assistant", target == null ? "Agent" : target.label, value);
        renderHistory();
        setBusy(false, "Ready");
        pushToTalk.complete("Reply received");
        if (speakReplies.isChecked()) speaker.speak(value);
    }

    private void fail(String value) {
        pendingText = null;
        setBusy(false, "Turn incomplete · not retried · " + value);
        status.setTextColor(ERROR);
        pushToTalk.complete("Send failed or uncertain · not retried");
    }

    private void setBusy(boolean busy, String message) {
        send.setEnabled(!busy);
        send.setAlpha(busy ? 0.42f : 1f);
        composer.setEnabled(!busy);
        agentTarget.setEnabled(!busy && find("lsrc:3") != null);
        windowsTarget.setEnabled(!busy && find("windows") != null);
        status.setText(message);
        status.setTextColor(busy ? WARNING : ACCENT);
        pushToTalk.refreshAvailability(!busy && selectedTarget() != null);
    }

    private ConversationTarget selectedTarget() {
        return find(selectedId);
    }

    private ConversationTarget find(String id) {
        for (ConversationTarget target : targets) if (target.id.equals(id)) return target;
        return null;
    }

    private Button targetButton(String label, String id) {
        Button button = button(label, Color.rgb(12, 18, 25), SECONDARY);
        button.setOnClickListener(view -> {
            if (controller.isBusy() || find(id) == null) return;
            selectedId = id;
            preferences.edit().putString(AppContract.KEY_CONVERSATION_TARGET, id).apply();
            renderTargets();
        });
        return button;
    }

    private void renderTargets() {
        styleTarget(agentTarget, "lsrc:3");
        styleTarget(windowsTarget, "windows");
        boolean ready = selectedTarget() != null && !controller.isBusy();
        send.setEnabled(ready);
        send.setAlpha(ready ? 1f : 0.42f);
        if (ready) status.setText("Ready for " + selectedTarget().label);
        else if (targets.isEmpty()) status.setText("Finding your favorites…");
        else status.setText("Selected favorite is offline");
        status.setTextColor(ready ? ACCENT : WARNING);
        pushToTalk.refreshAvailability(ready);
    }

    private void styleTarget(Button button, String id) {
        boolean available = find(id) != null;
        boolean selected = id.equals(selectedId) && available;
        button.setEnabled(available && !controller.isBusy());
        button.setTextColor(selected ? Color.rgb(5, 20, 15) : SECONDARY);
        button.setBackground(rounded(selected ? ACCENT : Color.rgb(12, 18, 25), 12,
            selected ? ACCENT : Color.rgb(41, 54, 65)));
        button.setAlpha(available ? 1f : 0.42f);
    }

    private void renderHistory() {
        List<ConversationStore.Message> messages = store.read();
        if (messages.isEmpty()) {
            history.setText("No conversation yet");
            history.setTextColor(SECONDARY);
            return;
        }
        StringBuilder value = new StringBuilder();
        for (ConversationStore.Message message : messages) {
            if (value.length() > 0) value.append("\n\n");
            value.append("user".equals(message.role)
                    ? "You → " + message.target + "\n"
                    : message.target + "\n")
                .append(message.text);
        }
        history.setText(value.toString());
        history.setTextColor(PRIMARY);
    }

    void cancelForBackground() { pushToTalk.cancelForBackground(); }
    void permissionResult(boolean granted) { pushToTalk.permissionResult(granted); }

    @Override
    public void close() {
        pushToTalk.close();
        controller.close();
        speaker.close();
    }

    private Button button(String label, int fill, int color) {
        Button button = new Button(activity);
        button.setText(label);
        button.setTextColor(color);
        button.setTextSize(13);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setAllCaps(false);
        button.setMinHeight(dp(46));
        button.setBackground(rounded(fill, 12, fill));
        return button;
    }

    private TextView text(String value, int size, boolean bold, int color) {
        TextView view = new TextView(activity);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private GradientDrawable rounded(int fill, int radius, int stroke) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(fill);
        shape.setCornerRadius(dp(radius));
        shape.setStroke(dp(1), stroke);
        return shape;
    }

    private LayoutParams margins(int top, int bottom) {
        LayoutParams params = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(top);
        params.bottomMargin = dp(bottom);
        return params;
    }

    private LayoutParams weightedButton(int left) {
        LayoutParams params = new LayoutParams(0, dp(46), 1);
        params.leftMargin = dp(left);
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
