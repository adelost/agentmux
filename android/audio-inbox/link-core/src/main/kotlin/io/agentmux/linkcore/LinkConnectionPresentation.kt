package io.agentmux.linkcore

/** Shared connection language for phone and Wear. */
fun linkConnectionLabel(connection: ConnectionState): String = when (connection) {
    ConnectionState.CONNECTED -> "CONNECTED"
    ConnectionState.CONNECTING -> "CONNECTING"
    ConnectionState.DISCONNECTED -> "DISCONNECTED"
    ConnectionState.CONFIGURATION_REQUIRED -> "PAIRING"
    ConnectionState.OFF -> "OFF"
}

fun linkConnectionRoute(state: LinkState): String = when {
    state.connection != ConnectionState.CONNECTED -> linkConnectionLabel(state.connection)
    state.connectionDetail.contains("public", ignoreCase = true) &&
        !state.connectionDetail.contains("tailscale", ignoreCase = true) -> "PUBLIC"
    else -> "PRIVATE"
}

fun linkConnectionSettingsDetail(state: LinkState): String = when (state.connection) {
    ConnectionState.CONNECTED ->
        state.connectionDetail.uppercase().take(42).ifBlank { "READY" }
    ConnectionState.CONNECTING -> "LOOKING FOR LINK"
    ConnectionState.DISCONNECTED -> "OPEN PHONE TO CONNECT"
    ConnectionState.CONFIGURATION_REQUIRED -> "OPEN PHONE TO PAIR"
    ConnectionState.OFF -> "LINK IS OFF"
}
