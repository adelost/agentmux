package io.agentmux.linkui

import io.agentmux.linkcore.LinkPreferenceKey

/** Existing audio capabilities, expressed once as content for the shared choice atom. */
data class LinkAudioPreference(
    val key: LinkPreferenceKey,
    val title: String,
    val hint: String,
    val enabled: Boolean,
)

fun linkAudioPreferences(readReplies: Boolean, announcements: Boolean) = listOf(
    LinkAudioPreference(LinkPreferenceKey.SPEAK_REPLIES, "READ REPLIES",
        "Read answers to your messages automatically. Off: tap Play when you want to listen.", readReplies),
    LinkAudioPreference(LinkPreferenceKey.HANDS_FREE, "ANNOUNCEMENTS",
        "Play separate audio updates sent to this device, including in the background. This does not control your replies.", announcements),
)
