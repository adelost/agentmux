package io.agentmux.audioinbox;

import android.net.Uri;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;

/** Media identity belongs to the accepted event, not a UI/player guess. */
final class AudioPlaybackMedia {
    static MediaItem item(AudioEventClaims.Entry entry) {
        return new MediaItem.Builder()
            .setMediaId(entry.eventId)
            .setUri(Uri.fromFile(entry.mediaFile))
            .setMediaMetadata(new MediaMetadata.Builder()
                .setTitle(entry.text).setArtist(entry.targetLabel).build())
            .build();
    }
}
