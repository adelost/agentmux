package io.agentmux.audioinbox;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
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

public final class MainActivity extends Activity {
    private SharedPreferences preferences;
    private EditText server;
    private EditText target;
    private Switch handsFree;
    private TextView connection;
    private TextView current;
    private TextView history;
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
        preferences = getSharedPreferences(AppContract.PREFS, MODE_PRIVATE);
        AppContract.consumerId(preferences);
        buildScreen();
        acceptLaunchConfiguration();
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
        unregisterReceiver(statusReceiver);
        super.onStop();
    }

    private void buildScreen() {
        int pad = Math.round(20 * getResources().getDisplayMetrics().density);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(pad, pad, pad, pad);

        TextView title = text("Agent Audio Inbox", 26, true);
        content.addView(title);
        TextView explanation = text(
            "Explicit amux say updates only. Tailscale is the network boundary.",
            15,
            false
        );
        explanation.setPadding(0, 4, 0, pad);
        content.addView(explanation);

        server = field("Voice server, e.g. http://100.x.y.z:8080");
        server.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        server.setText(preferences.getString(AppContract.KEY_SERVER, ""));
        content.addView(server);

        target = field("Discord target channel id");
        target.setText(preferences.getString(AppContract.KEY_TARGET, ""));
        content.addView(target);

        handsFree = new Switch(this);
        handsFree.setText("Hands-free");
        handsFree.setTextSize(20);
        handsFree.setPadding(0, pad, 0, pad);
        handsFree.setChecked(preferences.getBoolean(AppContract.KEY_ENABLED, false));
        handsFree.setOnCheckedChangeListener((button, enabled) -> setHandsFree(enabled));
        content.addView(handsFree);

        connection = text("Off", 16, true);
        content.addView(connection);
        current = text("Current: —", 16, false);
        current.setPadding(0, pad, 0, pad);
        content.addView(current);
        history = text("History: —", 14, false);
        content.addView(history);

        Button replay = new Button(this);
        replay.setText("Replay current");
        replay.setOnClickListener(view -> {
            Intent intent = new Intent(this, AudioInboxService.class);
            intent.setAction(AudioInboxService.ACTION_REPLAY);
            startService(intent);
        });
        content.addView(replay);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(content, new ScrollView.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        setContentView(scroll);
    }

    private TextView text(String value, int size, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private EditText field(String hint) {
        EditText field = new EditText(this);
        field.setHint(hint);
        field.setSingleLine(true);
        field.setLayoutParams(new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        return field;
    }

    private void acceptLaunchConfiguration() {
        String launchServer = getIntent().getStringExtra("serverUrl");
        String launchTarget = getIntent().getStringExtra("target");
        if (launchServer != null) server.setText(launchServer);
        if (launchTarget != null) target.setText(launchTarget);
    }

    private void setHandsFree(boolean enabled) {
        String serverValue = server.getText().toString().trim().replaceAll("/+$", "");
        String targetValue = target.getText().toString().trim();
        if (enabled && (!serverValue.matches("^https?://.+") || targetValue.isEmpty())) {
            handsFree.setChecked(false);
            Toast.makeText(this, "Set a server URL and target first", Toast.LENGTH_SHORT).show();
            return;
        }
        preferences.edit()
            .putBoolean(AppContract.KEY_ENABLED, enabled)
            .putString(AppContract.KEY_SERVER, serverValue)
            .putString(AppContract.KEY_TARGET, targetValue)
            .apply();
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
        String connectionAge = connectedAt == 0 ? "" : " · " + age(connectedAt);
        connection.setText(state + connectionAge);
        String currentText = preferences.getString(AppContract.KEY_CURRENT, "");
        long currentAt = preferences.getLong(AppContract.KEY_CURRENT_CREATED_AT, 0);
        current.setText(currentText == null || currentText.isBlank()
            ? "Current: —"
            : "Current (" + age(currentAt) + "): " + currentText);
        String items = preferences.getString(AppContract.KEY_HISTORY, "");
        history.setText(items == null || items.isBlank() ? "History: —" : "History:\n" + items);
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
}
