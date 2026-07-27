package io.agentmux.audioinbox.wear

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.LinkAction
import io.agentmux.linkcore.LinkReducer
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTarget

/**
 * WHAT: Builds the deliberately small round-watch presentation surface.
 * WHY: Keeps Wear navigation independent from the phone timeline implementation.
 */
class WearMainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val state = unavailableState()
        setContent {
            WearLinkScreen(
                state = state,
                onSelectTarget = {},
                onHoldToTalk = {},
                onPlay = {},
                onStop = {},
                onReplay = {},
            )
        }
    }
}

internal fun unavailableState(): LinkState {
    val targets = listOf("lsrc:3", "lsrc:10", "_windows_").map {
        LinkTarget(it, it, available = false)
    }
    return listOf<LinkAction>(
        LinkAction.Targets(targets),
        LinkAction.Connection(
            ConnectionState.CONFIGURATION_REQUIRED,
            "Public Link pairing is not available yet",
        ),
    ).fold(LinkState(), LinkReducer::reduce)
}
