package io.agentmux.audioinbox;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.media.MediaRecorder;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.widget.Button;
import android.widget.TextView;

import java.io.File;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class PushToTalkController {
    static final int MICROPHONE_PERMISSION_REQUEST = 702;

    interface Environment {
        boolean ready();
        String serverUrl();
        String target();
        String consumerId();
    }

    private final Activity activity;
    private final Button button;
    private final TextView status;
    private final Environment environment;
    private final ExecutorService sender = Executors.newSingleThreadExecutor();
    private final PushToTalkState state = new PushToTalkState();
    private MediaRecorder recorder;
    private File recording;
    private Boolean available;

    PushToTalkController(Activity activity, Button button, TextView status, Environment environment) {
        this.activity = activity;
        this.button = button;
        this.status = status;
        this.environment = environment;
        button.setOnTouchListener((view, event) -> onTouch(event));
    }

    private boolean onTouch(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
            begin();
            return true;
        }
        if (event.getActionMasked() == MotionEvent.ACTION_UP) {
            release();
            return true;
        }
        if (event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
            cancel("Recording cancelled");
            return true;
        }
        return true;
    }

    private void begin() {
        if (state.phase() != PushToTalkState.Phase.IDLE) return;
        if (!environment.ready()) {
            status.setText("Turn on hands-free listening first");
            return;
        }
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            status.setText("Microphone permission is required once");
            activity.requestPermissions(
                new String[]{Manifest.permission.RECORD_AUDIO},
                MICROPHONE_PERMISSION_REQUEST
            );
            return;
        }
        String turnId = UUID.randomUUID().toString();
        if (!state.begin(turnId, System.currentTimeMillis())) return;
        recording = new File(activity.getCacheDir(), "ptt-" + turnId + ".m4a");
        try {
            recorder = new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioChannels(1);
            recorder.setAudioSamplingRate(44_100);
            recorder.setAudioEncodingBitRate(96_000);
            recorder.setOutputFile(recording.getAbsolutePath());
            recorder.prepare();
            recorder.start();
            button.setText("Release to send");
            status.setText("Listening…");
            button.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
        } catch (Exception error) {
            discardRecorder();
            state.cancel();
            status.setText("Could not start the microphone");
        }
    }

    private void release() {
        PushToTalkState.Release release = state.release(System.currentTimeMillis());
        if (release == PushToTalkState.Release.IGNORE) return;
        if (release == PushToTalkState.Release.TOO_SHORT) {
            discardRecorder();
            resetButton();
            status.setText("Hold a little longer, then release");
            return;
        }
        String turnId = state.turnId();
        if (!stopRecorder()) {
            state.finish();
            resetButton();
            status.setText("Recording failed before send");
            return;
        }
        File audio = recording;
        recording = null;
        button.setEnabled(false);
        button.setText("Sending…");
        status.setText("Transcribing securely over Tailscale…");
        button.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
        sender.execute(() -> send(audio, turnId));
    }

    private void send(File audio, String turnId) {
        String message;
        try {
            AudioInboxHttpClient.PttResult result = new AudioInboxHttpClient(
                environment.serverUrl(),
                environment.consumerId()
            ).sendPushToTalk(audio, environment.target(), turnId);
            message = result.echoQueued
                ? "Heard: “" + result.transcript + "” · sent"
                : "Heard: “" + result.transcript + "” · sent, spoken echo unavailable";
        } catch (Exception error) {
            message = "Send failed or uncertain · not retried";
        } finally {
            if (audio != null) audio.delete();
        }
        String outcome = message;
        activity.runOnUiThread(() -> {
            state.finish();
            resetButton();
            status.setText(outcome);
        });
    }

    void permissionResult(boolean granted) {
        status.setText(granted
            ? "Ready · hold the button to talk"
            : "Microphone permission denied");
    }

    void refreshAvailability(boolean ready) {
        if (state.phase() != PushToTalkState.Phase.IDLE) return;
        if (available != null && available == ready) return;
        available = ready;
        if (!ready) status.setText("Turn on hands-free listening first");
        else status.setText("Hold while speaking · release to send");
    }

    void cancelForBackground() {
        if (state.phase() == PushToTalkState.Phase.RECORDING) {
            cancel("Recording cancelled when the app left the screen");
        }
    }

    void close() {
        cancelForBackground();
        sender.shutdownNow();
    }

    private void cancel(String reason) {
        if (!state.cancel()) return;
        discardRecorder();
        resetButton();
        status.setText(reason);
    }

    private boolean stopRecorder() {
        if (recorder == null) return false;
        try {
            recorder.stop();
            recorder.release();
            recorder = null;
            return recording != null && recording.length() > 0;
        } catch (RuntimeException error) {
            discardRecorder();
            return false;
        }
    }

    private void discardRecorder() {
        if (recorder != null) {
            try { recorder.reset(); } catch (Exception ignored) {}
            try { recorder.release(); } catch (Exception ignored) {}
            recorder = null;
        }
        if (recording != null) recording.delete();
        recording = null;
    }

    private void resetButton() {
        button.setText("Hold to talk");
        button.setEnabled(true);
    }
}
