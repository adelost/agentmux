package io.agentmux.audioinbox;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.Switch;
import android.widget.TextView;

import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static io.agentmux.audioinbox.AppPalette.*;

final class ConversationPanel extends LinearLayout implements AutoCloseable {
    private static final List<String> FAVORITE_ORDER = List.of("lsrc:3", "lsrc:10", "windows");

    private final Activity activity;
    private final SharedPreferences preferences;
    private final ConversationStore store;
    private final DirectReplySpeaker speaker;
    private final ConversationController controller;
    private final List<ConversationTarget> targets = new ArrayList<>();
    private final Map<String, Button> favoriteButtons = new HashMap<>();
    private final Map<String, AudioInboxHttpClient> clients = new HashMap<>();
    private final LinearLayout favoritesRow;
    private final Button restartWsl;
    private final LinearLayout messagesView;
    private final TextView status;
    private final EditText composer;
    private final Button send;
    private final Switch speakReplies;
    private final PushToTalkController pushToTalk;
    private final ImageLoader images = new ImageLoader();
    private ReplyPlayer replyPlayer;
    private String selectedId;
    private String pendingText;
    private String playingKey;

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

        favoritesRow = new LinearLayout(activity);
        favoritesRow.setOrientation(HORIZONTAL);
        favoritesRow.setPadding(0, dp(14), 0, 0);
        addView(favoritesRow);

        restartWsl = quietButton("Starta om WSL via Windows rescue");
        restartWsl.setOnClickListener(view -> confirmRestart());
        addView(restartWsl, margins(8, 0));

        messagesView = new LinearLayout(activity);
        messagesView.setOrientation(VERTICAL);
        addView(messagesView, margins(18, 14));

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
            sendText(null, composer.getText().toString());
            return true;
        });
        composeRow.addView(composer, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1));
        send = button("Send", ACCENT, Color.rgb(5, 20, 15));
        send.setOnClickListener(view -> sendText(null, composer.getText().toString()));
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
                public void onTranscript(ConversationTarget target, String value) { acceptTranscript(target, value); }
                public void onReply(ConversationTarget target, String value) { acceptReply(target, value); }
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
        replyPlayer = new ReplyPlayer(activity, new SpeechAudioFocus(activity, change -> {
            if (change <= 0 && replyPlayer != null) replyPlayer.stopPlayback();
        }), (key, playing, error) -> {
            playingKey = playing ? key : null;
            if (error != null) status.setText(error);
            renderMessages();
        });
        renderMessages();
        renderTargets();
    }

    void addDiscoveredTargets(List<ConversationTarget> discovered) {
        for (ConversationTarget target : discovered) {
            targets.removeIf(existing -> existing.id.equals(target.id));
            targets.add(target);
        }
        renderTargets();
    }

    private void sendText(ConversationTarget forcedTarget, String rawValue) {
        ConversationTarget target = forcedTarget != null ? forcedTarget : selectedTarget();
        String value = rawValue == null ? "" : rawValue.trim();
        if (target == null) {
            status.setText("That favorite is offline");
            return;
        }
        if (value.isEmpty() || controller.isBusy()) return;
        pendingText = value;
        if (!controller.sendText(target, value)) return;
        composer.setText("");
        store.append("user", target.label, value);
        renderMessages();
    }

    private void confirmRestart() {
        ConversationTarget windows = find("windows");
        if (windows == null || controller.isBusy()) return;
        new AlertDialog.Builder(activity)
            .setTitle("Starta om WSL?")
            .setMessage("Windows rescue får instruktionen att starta om WSL och bryggan. Pågående arbete kan avbrytas.")
            .setPositiveButton("Starta om", (dialog, which) -> sendText(windows, "Starta om WSL nu"))
            .setNegativeButton("Avbryt", null)
            .show();
    }

    private void acceptTranscript(ConversationTarget turnTarget, String value) {
        if (pendingText == null) {
            // A turn is always labeled by its recipient, never by whichever
            // favorite happens to be selected when the answer lands.
            store.append("user", turnTarget.label, value);
            renderMessages();
        }
        pendingText = null;
        status.setText("Message delivered · waiting for reply…");
    }

    private void acceptReply(ConversationTarget turnTarget, String value) {
        store.append("assistant", turnTarget.label, value);
        renderMessages();
        setBusy(false, "Ready");
        pushToTalk.complete("Reply received");
        if (speakReplies.isChecked()) playVoice(turnTarget, value, true);
    }

    private void fail(String value) {
        pendingText = null;
        setBusy(false, "Turn incomplete · not retried · " + value);
        status.setTextColor(ERROR);
        pushToTalk.complete("Send failed or uncertain · not retried");
    }

    private void playVoice(ConversationTarget target, String text, boolean autoplay) {
        if (target.kind == ConversationTarget.Kind.WINDOWS) {
            // The Windows rescue service has no TTS route; the phone reads it.
            speaker.speak(text);
            return;
        }
        AudioInboxHttpClient client = clients.computeIfAbsent(
            target.serverUrl,
            url -> new AudioInboxHttpClient(url, AppContract.consumerId(preferences))
        );
        String key = MessageMedia.voiceKey(target.label, text);
        if (autoplay) replyPlayer.play(client, key, text);
        else replyPlayer.toggle(client, key, text);
    }

    private void setBusy(boolean busy, String message) {
        send.setEnabled(!busy && selectedTarget() != null);
        send.setAlpha(busy ? 0.42f : 1f);
        composer.setEnabled(!busy);
        status.setText(message);
        status.setTextColor(busy ? WARNING : ACCENT);
        refreshFavorites();
        pushToTalk.refreshAvailability(!busy && selectedTarget() != null);
    }

    private ConversationTarget selectedTarget() {
        return find(selectedId);
    }

    private ConversationTarget find(String id) {
        for (ConversationTarget target : targets) if (target.id.equals(id)) return target;
        return null;
    }

    private void renderTargets() {
        favoritesRow.removeAllViews();
        favoriteButtons.clear();
        List<ConversationTarget> ordered = new ArrayList<>(targets);
        ordered.sort((a, b) -> Integer.compare(orderOf(a.id), orderOf(b.id)));
        boolean first = true;
        for (ConversationTarget target : ordered) {
            Button button = button("★ " + target.label, Color.rgb(12, 18, 25), SECONDARY);
            button.setOnClickListener(view -> {
                if (controller.isBusy()) return;
                selectedId = target.id;
                preferences.edit().putString(AppContract.KEY_CONVERSATION_TARGET, target.id).apply();
                refreshFavorites();
            });
            favoriteButtons.put(target.id, button);
            LayoutParams params = new LayoutParams(0, dp(46), 1);
            params.leftMargin = first ? 0 : dp(8);
            favoritesRow.addView(button, params);
            first = false;
        }
        refreshFavorites();
    }

    private int orderOf(String id) {
        int index = FAVORITE_ORDER.indexOf(id);
        return index >= 0 ? index : FAVORITE_ORDER.size();
    }

    private void refreshFavorites() {
        for (Map.Entry<String, Button> entry : favoriteButtons.entrySet()) {
            boolean available = true;
            boolean selected = entry.getKey().equals(selectedId);
            entry.getValue().setEnabled(!controller.isBusy());
            entry.getValue().setTextColor(selected ? Color.rgb(5, 20, 15) : SECONDARY);
            entry.getValue().setBackground(rounded(selected ? ACCENT : Color.rgb(12, 18, 25), 12,
                selected ? ACCENT : Color.rgb(41, 54, 65)));
            entry.getValue().setAlpha(available ? 1f : 0.42f);
        }
        ConversationTarget windows = find("windows");
        restartWsl.setEnabled(windows != null && !controller.isBusy());
        restartWsl.setAlpha(windows != null ? 1f : 0.42f);
        boolean ready = selectedTarget() != null && !controller.isBusy();
        send.setEnabled(ready);
        send.setAlpha(ready ? 1f : 0.42f);
        if (ready) status.setText("Ready for " + selectedTarget().label);
        else if (targets.isEmpty()) status.setText("Finding your favorites…");
        else status.setText("Selected favorite is offline");
        status.setTextColor(ready ? ACCENT : WARNING);
        pushToTalk.refreshAvailability(ready);
    }

    private void renderMessages() {
        messagesView.removeAllViews();
        List<ConversationStore.Message> messages = store.read();
        Set<String> voiceKeys = new HashSet<>();
        // The eager image budget favors the newest messages in the history.
        Set<String> imageBudget = new HashSet<>();
        for (int index = messages.size() - 1; index >= 0 && imageBudget.size() < 12; index--) {
            for (String url : MessageMedia.imageUrls(messages.get(index).text)) {
                if (imageBudget.size() >= 12) break;
                imageBudget.add(url);
            }
        }
        if (messages.isEmpty()) {
            TextView empty = text("No conversation yet", 15, false, SECONDARY);
            messagesView.addView(empty);
            return;
        }
        for (ConversationStore.Message message : messages) {
            boolean mine = "user".equals(message.role);
            TextView header = text(mine ? "You → " + message.target : message.target, 12, true, ACCENT);
            messagesView.addView(header, margins(10, 0));
            TextView body = text(message.text, 15, false, PRIMARY);
            body.setLineSpacing(dp(3), 1f);
            body.setTextIsSelectable(true);
            messagesView.addView(body, margins(2, 0));
            for (String url : MessageMedia.imageUrls(message.text)) {
                if (imageBudget.contains(url)) {
                    messagesView.addView(imageRow(url), margins(6, 0));
                }
            }
            if (!mine) {
                ConversationTarget origin = findByLabel(message.target);
                if (origin != null) {
                    String key = MessageMedia.voiceKey(message.target, message.text);
                    voiceKeys.add(key);
                    Button play = quietButton(key.equals(playingKey) ? "Stoppa rösten" : "Spela upp röstsvar");
                    play.setOnClickListener(view -> playVoice(origin, message.text, false));
                    messagesView.addView(play, margins(4, 0));
                }
            }
        }
        replyPlayer.prune(activity.getCacheDir(), voiceKeys);
    }

    private ConversationTarget findByLabel(String label) {
        for (ConversationTarget target : targets) if (target.label.equals(label)) return target;
        return null;
    }

    private LinearLayout imageRow(String url) {
        LinearLayout row = new LinearLayout(activity);
        row.setOrientation(VERTICAL);
        TextView placeholder = text("Loading image…", 12, false, SECONDARY);
        row.addView(placeholder);
        images.load(url, dp(280), new ImageLoader.Callback() {
            public void onBitmap(android.graphics.Bitmap bitmap) {
                row.removeAllViews();
                ImageView view = new ImageView(activity);
                view.setImageBitmap(bitmap);
                view.setAdjustViewBounds(true);
                view.setOnClickListener(clicked -> {
                    try {
                        activity.startActivity(new android.content.Intent(
                            android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)));
                    } catch (Exception ignored) {}
                });
                row.addView(view, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
            }
            public void onError() {
                placeholder.setText("Image could not be loaded · " + url);
            }
        });
        return row;
    }

    void cancelForBackground() { pushToTalk.cancelForBackground(); }
    void permissionResult(boolean granted) { pushToTalk.permissionResult(granted); }

    @Override
    public void close() {
        pushToTalk.close();
        controller.close();
        speaker.close();
        replyPlayer.close();
        images.close();
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

    private Button quietButton(String value) {
        Button button = new Button(activity);
        button.setText(value);
        button.setTextSize(12);
        button.setTextColor(SECONDARY);
        button.setAllCaps(false);
        button.setMinHeight(dp(42));
        button.setBackground(rounded(Color.TRANSPARENT, dp(12), Color.rgb(41, 54, 65)));
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

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
