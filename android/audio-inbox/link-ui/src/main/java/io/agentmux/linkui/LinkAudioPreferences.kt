package io.agentmux.linkui

import io.agentmux.linkcore.LinkPreferenceKey
import io.agentmux.wakeword.WakePhase
import io.agentmux.linkui.product.LinkWakePresentation

/** WHAT: Carries one audio preference row. WHY: Keeps shared choice content independent of its host renderer. */
data class LinkAudioPreference(
    val key: LinkPreferenceKey,
    val title: String,
    val hint: String,
    val enabled: Boolean,
)

/** WHAT: Builds Link's audio preference rows. WHY: Keeps labels and values consistent across Settings renders. */
fun linkAudioPreferences(
    readReplies: Boolean,
    announcements: Boolean,
    wakeWord: Boolean,
    listeningCueSound: Boolean,
) = listOf(
    LinkAudioPreference(LinkPreferenceKey.SPEAK_REPLIES, "READ REPLIES",
        "• Replies play by themselves\n• Off: tap the speaker", readReplies),
    LinkAudioPreference(LinkPreferenceKey.HANDS_FREE, "ANNOUNCEMENTS",
        "• Plays updates sent to this phone\n• Not your replies", announcements),
    LinkAudioPreference(LinkPreferenceKey.WAKE_WORD, "WAKE WORD",
        "• Say the wake phrase, then ask\n• The answer is read aloud", wakeWord),
    LinkAudioPreference(LinkPreferenceKey.LISTENING_CUE_SOUND, "LISTENING SOUND",
        "• Soft cue when listening starts\n• Off keeps the haptic", listeningCueSound),
)

/**
 * WHAT: The two labels the WAKE WORD toggle shows, off first.
 * WHY: lsrc:0 S1, 2026-09-19. Settings carried a row reading LISTENING FOR "HEY JARVIS" between WAKE
 * PHRASE and WAKE DEBUG, which is a status line dressed as a row; the toggle says it instead. A loop that
 * is on but not listening says only ON, because what it is doing then is the main page's to report and
 * naming it here would be a second answer to the same question.
 */
fun linkWakeToggleLabels(wake: LinkWakePresentation): Pair<String, String> = "OFF" to when (wake.phase) {
    WakePhase.LISTENING -> "ON · listening for \"${wake.phrase.spoken}\""
    else -> "ON"
}
