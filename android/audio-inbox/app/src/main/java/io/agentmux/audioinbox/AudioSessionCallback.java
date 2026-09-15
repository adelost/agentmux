package io.agentmux.audioinbox;

import android.os.Bundle;

import androidx.annotation.OptIn;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.CommandButton;
import androidx.media3.session.MediaSession;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionCommands;
import androidx.media3.session.SessionError;
import androidx.media3.session.SessionResult;

import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

import java.util.List;

/** Makes Stop an honest MediaSession command instead of a raw player reset. */
@OptIn(markerClass = UnstableApi.class)
final class AudioSessionCallback implements MediaSession.Callback {
    private static final SessionCommand STOP =
        new SessionCommand("io.agentmux.audioinbox.STOP_PLAYBACK", Bundle.EMPTY);
    private static final CommandButton STOP_BUTTON = new CommandButton.Builder(CommandButton.ICON_STOP)
        .setSessionCommand(STOP)
        .setDisplayName("Stop")
        .setSlots(CommandButton.SLOT_FORWARD)
        .build();

    private final Runnable stop;

    AudioSessionCallback(Runnable stop) {
        this.stop = stop;
    }

    @Override
    public MediaSession.ConnectionResult onConnect(
        MediaSession session,
        MediaSession.ControllerInfo controller
    ) {
        SessionCommands commands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS
            .buildUpon()
            .add(STOP)
            .build();
        return new MediaSession.ConnectionResult.AcceptedResultBuilder(session)
            .setAvailableSessionCommands(commands)
            .setAvailablePlayerCommands(MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS)
            .setMediaButtonPreferences(List.of(STOP_BUTTON))
            .build();
    }

    @Override
    public int onPlayerCommandRequest(
        MediaSession session,
        MediaSession.ControllerInfo controller,
        int command
    ) {
        if (command != Player.COMMAND_STOP) return SessionResult.RESULT_SUCCESS;
        stop.run();
        return SessionError.INFO_CANCELLED;
    }

    @Override
    public ListenableFuture<SessionResult> onCustomCommand(
        MediaSession session,
        MediaSession.ControllerInfo controller,
        SessionCommand command,
        Bundle args
    ) {
        if (!STOP.equals(command)) {
            return Futures.immediateFuture(
                new SessionResult(SessionError.ERROR_NOT_SUPPORTED)
            );
        }
        stop.run();
        return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
    }
}
