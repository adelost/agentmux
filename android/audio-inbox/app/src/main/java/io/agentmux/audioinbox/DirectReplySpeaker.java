package io.agentmux.audioinbox;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import java.util.Locale;
import java.util.UUID;

final class DirectReplySpeaker implements AutoCloseable {
    private final AudioManager audioManager;
    private TextToSpeech tts;
    private boolean ready;
    private AudioFocusRequest focusRequest;

    DirectReplySpeaker(Context context) {
        audioManager = context.getSystemService(AudioManager.class);
        tts = new TextToSpeech(context.getApplicationContext(), status -> {
            ready = status == TextToSpeech.SUCCESS;
            if (ready) {
                tts.setLanguage(new Locale("sv", "SE"));
                tts.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            }
        });
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            public void onStart(String utteranceId) {}
            public void onError(String utteranceId) { abandonFocus(); }
            public void onDone(String utteranceId) { abandonFocus(); }
        });
    }

    void speak(String text) {
        String clean = String.valueOf(text).trim();
        if (!ready || clean.isEmpty() || !requestFocus()) return;
        tts.speak(clean, TextToSpeech.QUEUE_FLUSH, null, "reply-" + UUID.randomUUID());
    }

    private boolean requestFocus() {
        if (Build.VERSION.SDK_INT >= 26) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build())
                .setOnAudioFocusChangeListener(change -> {
                    if (change == AudioManager.AUDIOFOCUS_LOSS && tts != null) tts.stop();
                })
                .build();
            return audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        }
        return audioManager.requestAudioFocus(
            ignored -> {},
            AudioManager.STREAM_MUSIC,
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
        ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    private void abandonFocus() {
        if (Build.VERSION.SDK_INT >= 26 && focusRequest != null) {
            audioManager.abandonAudioFocusRequest(focusRequest);
            focusRequest = null;
        } else {
            audioManager.abandonAudioFocus(null);
        }
    }

    @Override
    public void close() {
        abandonFocus();
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
        }
        ready = false;
    }
}
