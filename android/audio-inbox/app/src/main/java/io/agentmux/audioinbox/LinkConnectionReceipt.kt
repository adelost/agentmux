package io.agentmux.audioinbox

import android.content.SharedPreferences
import android.util.Log
import io.agentmux.linkcore.ConnectionState

/** The stored announcement feed receipt as a Link connection change, or null when it should change nothing. */
internal fun SharedPreferences.announcementFeedReceipt(): Pair<ConnectionState, String>? {
    val raw = getString(AppContract.KEY_CONNECTION, null) ?: return null
    return announcementFeedConnection(raw, getBoolean(AppContract.KEY_ENABLED, false))?.let { it to raw }
}

/**
 * WHAT: What the audio service's receipt says about Link's connection, or null when it says nothing about the network.
 * WHY: The receipt describes the ANNOUNCEMENTS feed. It used to map every other string to DISCONNECTED, so a
 * finished reply with announcements off showed "DISCONNECTED" while Tailscale turns kept working
 * (Mattias 2026-09-15: "den här disconnected upp lite titt som tätt ... Den verkar fortfarande fungera").
 */
internal fun announcementFeedConnection(raw: String, announcementsOn: Boolean): ConnectionState? {
    if (!announcementsOn) return null
    return when (FeedReceipt.of(raw)) {
        FeedReceipt.CONNECTED -> ConnectionState.CONNECTED
        FeedReceipt.CONNECTING -> ConnectionState.CONNECTING
        FeedReceipt.DISCONNECTED -> ConnectionState.DISCONNECTED
        FeedReceipt.CONFIGURATION_REQUIRED -> ConnectionState.CONFIGURATION_REQUIRED
        // Playing a saved reply, or the feed switched off, proves nothing about the route.
        FeedReceipt.PLAYING, FeedReceipt.OFF -> null
        null -> null.also { Log.w("LinkConnection", "Unknown audio feed receipt ignored: ${raw.take(60)}") }
    }
}

/** The receipt vocabulary AudioInboxService writes; the prefix carries the state, the rest is detail. */
internal enum class FeedReceipt(val prefix: String) {
    PLAYING("Playing"),
    CONNECTED("Connected"),
    CONNECTING("Connecting"),
    DISCONNECTED("Disconnected"),
    OFF("Off"),
    CONFIGURATION_REQUIRED("Configuration");

    companion object {
        fun of(raw: String): FeedReceipt? = entries.firstOrNull { raw.startsWith(it.prefix, ignoreCase = true) }
    }
}
