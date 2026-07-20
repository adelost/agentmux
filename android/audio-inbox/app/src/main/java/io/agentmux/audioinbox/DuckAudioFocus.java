package io.agentmux.audioinbox;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;

final class DuckAudioFocus implements PlaybackQueue.FocusPort {
    static final int DURATION_HINT = AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK;

    private final AudioManager audioManager;
    private final AudioManager.OnAudioFocusChangeListener listener;
    private AudioFocusRequest request;
    private boolean held;

    DuckAudioFocus(Context context, AudioManager.OnAudioFocusChangeListener listener) {
        this.audioManager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        this.listener = listener;
    }

    @Override
    public synchronized boolean requestMayDuck() {
        if (held) return true;
        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (request == null) {
                AudioAttributes attributes = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build();
                request = new AudioFocusRequest.Builder(DURATION_HINT)
                    .setAudioAttributes(attributes)
                    .setAcceptsDelayedFocusGain(false)
                    .setOnAudioFocusChangeListener(listener)
                    .build();
            }
            result = audioManager.requestAudioFocus(request);
        } else {
            result = audioManager.requestAudioFocus(
                listener,
                AudioManager.STREAM_MUSIC,
                DURATION_HINT
            );
        }
        held = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        return held;
    }

    @Override
    public synchronized void abandon() {
        if (!held) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && request != null) {
            audioManager.abandonAudioFocusRequest(request);
        } else {
            audioManager.abandonAudioFocus(listener);
        }
        held = false;
    }
}
