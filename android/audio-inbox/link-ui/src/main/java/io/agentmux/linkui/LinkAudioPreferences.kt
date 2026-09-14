package io.agentmux.linkui

import io.agentmux.linkcore.LinkPreferenceKey

/** Existing audio capabilities, expressed once as content for the shared choice atom. */
data class LinkAudioPreference(
    val key: LinkPreferenceKey,
    val title: String,
    val hint: String,
    val enabled: Boolean,
)

fun linkAudioPreferences(readReplies: Boolean, announcements: Boolean, wakeWord: Boolean) = listOf(
    LinkAudioPreference(LinkPreferenceKey.SPEAK_REPLIES, "READ REPLIES",
        "• Replies play by themselves\n• Off: tap the speaker", readReplies),
    LinkAudioPreference(LinkPreferenceKey.HANDS_FREE, "ANNOUNCEMENTS",
        "• Plays updates sent to this phone\n• Not your replies", announcements),
    LinkAudioPreference(LinkPreferenceKey.WAKE_WORD, "WAKE WORD",
        "• Say the wake phrase, then ask\n• The answer is read aloud", wakeWord),
)
