package io.agentmux.audioinbox;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import static io.agentmux.audioinbox.AppPalette.*;

public final class MainActivity extends Activity {
    private SharedPreferences preferences;
    private EditText server;
    private EditText target;
    private Switch handsFree;
    private TextView provisioning;
    private LinearLayout advanced;
    private TextView connection;
    private TextView current;
    private TextView history;
    private Button replay;
    private ConversationPanel conversationPanel;
    private final ExecutorService discoveryExecutor = Executors.newFixedThreadPool(2);
    private final Handler refreshHandler = new Handler(Looper.getMainLooper());
    private final Runnable refresher = new Runnable() {
        @Override
        public void run() {
            renderStatus();
            refreshHandler.postDelayed(this, 1000);
        }
    };
    private final BroadcastReceiver statusReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            renderStatus();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BACKGROUND);
        getWindow().setNavigationBarColor(BACKGROUND);
        preferences = getSharedPreferences(AppContract.PREFS, MODE_PRIVATE);
        AppContract.consumerId(preferences);
        buildScreen();
        acceptLaunchConfiguration();
        discoverConfiguration();
        requestNotificationPermission();
    }

    @Override
    protected void onStart() {
        super.onStart();
        IntentFilter filter = new IntentFilter(AppContract.ACTION_STATUS);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(statusReceiver, filter);
        }
        refreshHandler.post(refresher);
    }

    @Override
    protected void onStop() {
        refreshHandler.removeCallbacks(refresher);
        conversationPanel.cancelForBackground();
        unregisterReceiver(statusReceiver);
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        conversationPanel.close();
        discoveryExecutor.shutdownNow();
        super.onDestroy();
    }

    private void buildScreen() {
        int pad = dp(20);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(pad, dp(24), pad, dp(32));
        content.setBackgroundColor(BACKGROUND);

        content.addView(sectionLabel("PRIVATE AGENT LINK"));
        TextView title = text("Agentmux Link", 34, true, PRIMARY);
        title.setLetterSpacing(-0.02f);
        content.addView(title, blockMargins(2, 4));
        TextView explanation = text(
            "Talk to your agents, or hear explicit updates, over your private tailnet.",
            15,
            false,
            SECONDARY
        );
        explanation.setLineSpacing(0, 1.15f);
        content.addView(explanation, blockMargins(0, 22));

        LinearLayout statusCard = card();
        LinearLayout statusRow = new LinearLayout(this);
        statusRow.setOrientation(LinearLayout.HORIZONTAL);
        statusRow.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout statusCopy = new LinearLayout(this);
        statusCopy.setOrientation(LinearLayout.VERTICAL);
        statusCopy.addView(text("Hands-free listening", 19, true, PRIMARY));
        statusCopy.addView(text("Only explicit audio updates", 13, false, SECONDARY));
        statusRow.addView(statusCopy, new LinearLayout.LayoutParams(0,
            ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        handsFree = new Switch(this);
        handsFree.setContentDescription("Hands-free listening");
        handsFree.setChecked(preferences.getBoolean(AppContract.KEY_ENABLED, false));
        handsFree.setEnabled(false);
        handsFree.setOnCheckedChangeListener((button, enabled) -> setHandsFree(enabled));
        tintSwitch(handsFree);
        statusRow.addView(handsFree, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            dp(48)
        ));
        statusCard.addView(statusRow);

        connection = text("Off", 15, true, SECONDARY);
        statusCard.addView(connection, blockMargins(18, 3));
        provisioning = text("Finding Agentmux on Tailscale…", 13, false, WARNING);
        statusCard.addView(provisioning);
        content.addView(statusCard, blockMargins(0, 12));

        Button advancedToggle = quietButton("Advanced settings");
        content.addView(advancedToggle, blockMargins(0, 12));

        advanced = new LinearLayout(this);
        advanced.setOrientation(LinearLayout.VERTICAL);
        advanced.setPadding(dp(14), dp(14), dp(14), 0);
        advanced.setBackground(rounded(Color.rgb(12, 18, 25), dp(16), Color.rgb(41, 54, 65)));
        advanced.setVisibility(LinearLayout.GONE);

        server = field("Voice server, e.g. http://100.x.y.z:8080");
        server.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        server.setText(preferences.getString(AppContract.KEY_SERVER, ""));
        advanced.addView(server);

        target = field("Discord target channel id");
        target.setText(preferences.getString(AppContract.KEY_TARGET, ""));
        advanced.addView(target);
        content.addView(advanced, blockMargins(0, 14));
        advancedToggle.setOnClickListener(view -> {
            boolean show = advanced.getVisibility() != LinearLayout.VISIBLE;
            advanced.setVisibility(show ? LinearLayout.VISIBLE : LinearLayout.GONE);
            advancedToggle.setText(show ? "Hide advanced settings" : "Advanced settings");
        });

        content.addView(sectionLabel("CONVERSATION"), blockMargins(8, 8));
        conversationPanel = new ConversationPanel(this, preferences);
        content.addView(conversationPanel, blockMargins(0, 22));

        content.addView(sectionLabel("LATEST UPDATE"), blockMargins(8, 8));
        LinearLayout latestCard = card();
        current = text("No update yet", 17, false, PRIMARY);
        current.setLineSpacing(0, 1.12f);
        latestCard.addView(current);
        replay = primaryButton("Replay current");
        replay.setOnClickListener(view -> {
            Intent intent = new Intent(this, AudioInboxService.class);
            intent.setAction(AudioInboxService.ACTION_REPLAY);
            startService(intent);
        });
        latestCard.addView(replay, blockMargins(18, 0));
        content.addView(latestCard, blockMargins(0, 22));

        content.addView(sectionLabel("RECENT"), blockMargins(0, 8));
        LinearLayout historyCard = card();
        history = text("Nothing played yet", 14, false, SECONDARY);
        history.setLineSpacing(dp(3), 1f);
        historyCard.addView(history);
        content.addView(historyCard, blockMargins(0, 18));

        TextView privacy = text(
            "The microphone is active only while you hold Talk. Audio stays on your private tailnet.",
            12,
            false,
            SECONDARY
        );
        privacy.setGravity(Gravity.CENTER);
        privacy.setLineSpacing(0, 1.12f);
        content.addView(privacy, blockMargins(0, 0));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(BACKGROUND);
        scroll.addView(content, new ScrollView.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        setContentView(scroll);
    }

    private TextView text(String value, int size, boolean bold, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private TextView sectionLabel(String value) {
        TextView label = text(value, 11, true, ACCENT);
        label.setLetterSpacing(0.16f);
        return label;
    }

    private LinearLayout card() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(18), dp(17), dp(18), dp(17));
        card.setBackground(rounded(SURFACE, dp(18), Color.rgb(34, 46, 57)));
        return card;
    }

    private Button primaryButton(String value) {
        Button button = new Button(this);
        button.setText(value);
        button.setTextSize(14);
        button.setTextColor(Color.rgb(5, 20, 15));
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setAllCaps(false);
        button.setMinHeight(dp(48));
        button.setBackground(rounded(ACCENT, dp(14), ACCENT));
        return button;
    }

    private Button quietButton(String value) {
        Button button = new Button(this);
        button.setText(value);
        button.setTextSize(13);
        button.setTextColor(SECONDARY);
        button.setAllCaps(false);
        button.setMinHeight(dp(46));
        button.setBackground(rounded(Color.TRANSPARENT, dp(14), Color.rgb(41, 54, 65)));
        return button;
    }

    private EditText field(String hint) {
        EditText field = new EditText(this);
        field.setHint(hint);
        field.setHintTextColor(Color.rgb(107, 126, 137));
        field.setTextColor(PRIMARY);
        field.setTextSize(14);
        field.setPadding(dp(13), 0, dp(13), 0);
        field.setMinHeight(dp(50));
        field.setBackground(rounded(BACKGROUND, dp(12), Color.rgb(41, 54, 65)));
        field.setSingleLine(true);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.bottomMargin = dp(14);
        field.setLayoutParams(params);
        return field;
    }

    private GradientDrawable rounded(int fill, int radius, int stroke) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(fill);
        shape.setCornerRadius(radius);
        shape.setStroke(dp(1), stroke);
        return shape;
    }

    private LinearLayout.LayoutParams blockMargins(int top, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.topMargin = dp(top);
        params.bottomMargin = dp(bottom);
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void acceptLaunchConfiguration() {
        String launchServer = getIntent().getStringExtra("serverUrl");
        String launchTarget = getIntent().getStringExtra("target");
        if (launchServer != null) server.setText(launchServer);
        if (launchTarget != null) target.setText(launchTarget);
    }

    private void discoverConfiguration() {
        String currentServer = server.getText().toString().trim().replaceAll("/+$", "");
        String currentTarget = target.getText().toString().trim();
        boolean savedConnection = ServerDiscovery.isAllowedServer(currentServer)
            && currentTarget.matches("^\\d{10,24}$");
        if (savedConnection) {
            saveConfiguration(currentServer, currentTarget);
            provisioning.setText("Ready · saved connection");
            provisioning.setTextColor(ACCENT);
            handsFree.setEnabled(true);
            resumeHandsFreeIfEnabled();
        }
        if (!savedConnection) {
            provisioning.setText("Finding Agentmux on Tailscale…");
            provisioning.setTextColor(WARNING);
        }
        discoveryExecutor.execute(() -> applyWslDiscovery(
            ServerDiscovery.discover(ServerDiscovery.WSL_CANDIDATES), savedConnection
        ));
        discoveryExecutor.execute(() -> applyConversationDiscovery(
            ServerDiscovery.discover(ServerDiscovery.WINDOWS_CANDIDATES)
        ));
    }

    private void applyWslDiscovery(ServerDiscovery.Configuration found, boolean savedConnection) {
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) return;
            if (found == null) {
                if (!savedConnection) {
                    provisioning.setText("Server not found · check Tailscale or use Advanced");
                    provisioning.setTextColor(ERROR);
                    advanced.setVisibility(LinearLayout.VISIBLE);
                    handsFree.setEnabled(true);
                }
                return;
            }
            server.setText(found.serverUrl);
            target.setText(found.target);
            saveConfiguration(found.serverUrl, found.target);
            provisioning.setText("Ready via Tailscale · " + found.serverId);
            provisioning.setTextColor(ACCENT);
            handsFree.setEnabled(true);
            resumeHandsFreeIfEnabled();
            conversationPanel.addDiscoveredTargets(found.conversationTargets);
        });
    }

    private void applyConversationDiscovery(ServerDiscovery.Configuration found) {
        runOnUiThread(() -> {
            if (!isFinishing() && !isDestroyed() && found != null) {
                conversationPanel.addDiscoveredTargets(found.conversationTargets);
            }
        });
    }

    private void resumeHandsFreeIfEnabled() {
        if (!preferences.getBoolean(AppContract.KEY_ENABLED, false)) return;
        Intent intent = new Intent(this, AudioInboxService.class);
        intent.setAction(AppContract.ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
        else startService(intent);
    }

    private void saveConfiguration(String serverValue, String targetValue) {
        preferences.edit()
            .putString(AppContract.KEY_SERVER, serverValue)
            .putString(AppContract.KEY_TARGET, targetValue)
            .apply();
    }

    private void setHandsFree(boolean enabled) {
        String serverValue = server.getText().toString().trim().replaceAll("/+$", "");
        String targetValue = target.getText().toString().trim();
        if (enabled && (!ServerDiscovery.isAllowedServer(serverValue)
            || !targetValue.matches("^\\d{10,24}$"))) {
            handsFree.setChecked(false);
            advanced.setVisibility(LinearLayout.VISIBLE);
            Toast.makeText(
                this,
                "No verified Agentmux server is configured",
                Toast.LENGTH_SHORT
            ).show();
            return;
        }
        saveConfiguration(serverValue, targetValue);
        preferences.edit().putBoolean(AppContract.KEY_ENABLED, enabled).apply();
        Intent intent = new Intent(this, AudioInboxService.class);
        intent.setAction(enabled ? AppContract.ACTION_START : AppContract.ACTION_STOP);
        if (enabled && Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
        else startService(intent);
    }

    private void renderStatus() {
        boolean enabled = preferences.getBoolean(AppContract.KEY_ENABLED, false);
        if (handsFree.isChecked() != enabled) handsFree.setChecked(enabled);
        String state = preferences.getString(AppContract.KEY_CONNECTION, enabled ? "Connecting" : "Off");
        long connectedAt = preferences.getLong(AppContract.KEY_CONNECTED_AT, 0);
        String connectionAge = connectedAt == 0 || "Off".equals(state)
            ? ""
            : " · " + age(connectedAt);
        connection.setText(state + connectionAge);
        connection.setTextColor(connectionColor(state));
        String currentText = preferences.getString(AppContract.KEY_CURRENT, "");
        long currentAt = preferences.getLong(AppContract.KEY_CURRENT_CREATED_AT, 0);
        boolean hasCurrent = currentText != null && !currentText.isBlank();
        current.setText(hasCurrent
            ? currentText + "\n" + age(currentAt) + " ago"
            : "No update yet");
        current.setTextColor(hasCurrent ? PRIMARY : SECONDARY);
        replay.setEnabled(hasCurrent);
        replay.setAlpha(hasCurrent ? 1f : 0.38f);
        String items = preferences.getString(AppContract.KEY_HISTORY, "");
        history.setText(items == null || items.isBlank() ? "Nothing played yet" : items);
        history.setTextColor(items == null || items.isBlank() ? SECONDARY : PRIMARY);
    }

    private int connectionColor(String state) {
        String normalized = state == null ? "" : state.toLowerCase();
        if (normalized.startsWith("connected") || normalized.startsWith("playing")) return ACCENT;
        if (normalized.startsWith("connecting")) return WARNING;
        if (normalized.startsWith("off")) return SECONDARY;
        return ERROR;
    }

    private String age(long epochMillis) {
        if (epochMillis <= 0) return "—";
        long seconds = Math.max(0, Duration.between(
            Instant.ofEpochMilli(epochMillis),
            Instant.now()
        ).getSeconds());
        if (seconds < 60) return seconds + "s";
        if (seconds < 3600) return (seconds / 60) + "m";
        return (seconds / 3600) + "h " + ((seconds % 3600) / 60) + "m";
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == PushToTalkController.MICROPHONE_PERMISSION_REQUEST) {
            conversationPanel.permissionResult(
                results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED
            );
        }
    }
}
