// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM product-spec/src/interactions.ts
// Product declaration SHA-256: 0c28340bd35049f9c5d55953cbd5a1365aba31c596040dd20d0a3dc6bc089a02
package io.agentmux.linkui.product.generated

import com.adelost.designkit.ui.CircleActionTiming

/**
 * Which kind of button each Link control is: touch or hold, and nothing between them.
 *
 * The two words and the rule that picks between them belong to the shared ProductSpec vocabulary.
 * A control reads its own constant here, so nothing else can decide for it.
 *
 * GESTURES THAT DECLARE NO TIMING, because their duration is the content rather than a confirmation:
 * - PUSH TO TALK: Held to record and released to send: the duration is the message, not a confirmation of it.
 */
object GeneratedLinkControlTiming {
    /** WAKE WORD. A toggle, which ordinary use recovers. */
    val SETTINGS_WAKE_WORD: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** WAKE PHRASE. A choice between declared phrases, which ordinary use recovers. */
    val SETTINGS_WAKE_PHRASE: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** SPEAK REPLIES. A toggle, which ordinary use recovers. */
    val SETTINGS_SPEAK_REPLIES: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** HANDS FREE. A toggle, which ordinary use recovers. */
    val SETTINGS_HANDS_FREE: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** LISTENING SOUND. A toggle; haptic stays on, which ordinary use recovers. */
    val SETTINGS_LISTENING_CUE_SOUND: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** SENSITIVITY. Navigation: it opens the wake-try page. */
    val SETTINGS_SENSITIVITY: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** DISPLAY PREVIEW. Navigation: it opens a preview. */
    val SETTINGS_DISPLAY_PREVIEW: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** SIGN OUT · CONNECT ONLINE. Session state. Measured on the path (LinkCoordinator.logoutPublic): it revokes the session and clears the stored credentials, and keeps the history, the queued messages, the favourites and the wake phrase. Signing in again restores what it changed. */
    val SETTINGS_PUBLIC_LINK: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** UPDATE. The platform installer asks its own question after the press, and the APK is already downloaded. */
    val SETTINGS_INSTALL_UPDATE: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** CLEAR <recipient>. It destroys the conversation on this phone, and no second press brings it back. */
    val HISTORY_CLEAR: CircleActionTiming = CircleActionTiming.DELIBERATE

    /** TRY <PHRASE>. Trying again is the whole point of the page. */
    val WAKE_TRY_TRY_PHRASE: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** WAKE DEBUG. Navigation: it opens the wake-debug page. */
    val SETTINGS_WAKE_DEBUG: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** WATCHING · NOT WATCHING. A toggle on the wake-debug page, which ordinary use recovers. */
    val DEBUG_WAKE_WATCHING: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** EXPORT. It writes one debug file the wearer asked for; nothing on the page changes and nothing is sent. */
    val DEBUG_WAKE_EXPORT: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** HOST PREVIEW. Navigation. */
    val DEV_HOST_PREVIEW: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** PRODUCT PORTS. Navigation. */
    val DEV_PRODUCT_PORTS: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** SETTINGS. Navigation. */
    val CHROME_OPEN_SETTINGS: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** <phrase>. A toggle on the home page, writing the same preference Settings writes, which ordinary use recovers. */
    val HOME_WAKE_TOGGLE: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** VOICE MESSAGE. Navigation: it opens the capture screen and sends nothing. */
    val HOME_VOICE_MESSAGE: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** REPLY. Navigation: it opens the reply and sends nothing. */
    val HOME_REPLY: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** HISTORY. Navigation. */
    val HOME_HISTORY: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** RECIPIENT. Navigation: it opens the picker. */
    val HOME_RECIPIENT: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** <recipient>. A choice, which ordinary use recovers. */
    val RECIPIENTS_SELECT: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** FAVORITES. Navigation: it opens editing. */
    val RECIPIENTS_FAVORITES: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** <turn>. Playback, which ordinary use recovers. */
    val CONVERSATION_PLAY_TURN: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** OPEN LINK. Navigation, out to a browser. */
    val CONVERSATION_OPEN_LINK: CircleActionTiming = CircleActionTiming.IMMEDIATE

    /** <conversation turn>. Navigation: it opens the turn. */
    val CONVERSATION_OPEN_TURN: CircleActionTiming = CircleActionTiming.IMMEDIATE
}
