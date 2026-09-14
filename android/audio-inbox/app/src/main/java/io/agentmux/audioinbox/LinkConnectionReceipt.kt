package io.agentmux.audioinbox

import io.agentmux.linkcore.ConnectionState

/** Maps the audio service's human connection receipt onto the typed connection axis. */
internal fun connectionStateOfReceipt(raw: String): ConnectionState = when {
    raw.startsWith("Playing", ignoreCase = true) -> ConnectionState.CONNECTED
    raw.startsWith("Connected", ignoreCase = true) -> ConnectionState.CONNECTED
    raw.startsWith("Connecting", ignoreCase = true) -> ConnectionState.CONNECTING
    raw.startsWith("Off", ignoreCase = true) -> ConnectionState.OFF
    raw.startsWith("Configuration", ignoreCase = true) -> ConnectionState.CONFIGURATION_REQUIRED
    else -> ConnectionState.DISCONNECTED
}
