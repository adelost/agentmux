/**
 * Which kind of button each Link control is, declared once and read by the Kotlin.
 *
 * Row 225. Mattias pressed SETTINGS · WAKE PHRASE for a millisecond and it switched, while the row
 * drew a half-second arc: "det ska inte finnas något mellanting liksom, bara de här två typerna
 * utav knappar". The kit now resolves one timing per control (circlekit #250), but Link said nothing
 * about any of its controls: a host-wide override declared every one of them immediate at once, so
 * there was nothing written down for a control to disagree with.
 *
 * The two words and the rule that picks between them are @v1d/product-spec's, shared with Skyvw and
 * the showcase, so this file states only WHICH each Link control is and why.
 */

import type { InteractionTiming } from "@v1d/product-spec";

export interface LinkControlDeclaration {
  /** Stable id, and the source of the generated Kotlin constant's name. */
  readonly id: string;
  /** What the control says on the glass, so the list can be read against the app. */
  readonly title: string;
  readonly timing: InteractionTiming;
  /** Why it is that kind, in the rule's own terms. Emitted as the constant's comment. */
  readonly why: string;
}

const recovers = (what: string) => `${what}, which ordinary use recovers.`;

export const linkControls: readonly LinkControlDeclaration[] = [
  { id: "settings.wake-word", title: "WAKE WORD", timing: "immediate", why: recovers("A toggle") },
  { id: "settings.wake-phrase", title: "WAKE PHRASE", timing: "immediate", why: recovers("A choice between declared phrases") },
  { id: "settings.speak-replies", title: "SPEAK REPLIES", timing: "immediate", why: recovers("A toggle") },
  { id: "settings.hands-free", title: "HANDS FREE", timing: "immediate", why: recovers("A toggle") },
  { id: "settings.listening-cue-sound", title: "LISTENING SOUND", timing: "immediate", why: recovers("A toggle; haptic stays on") },
  { id: "settings.sensitivity", title: "SENSITIVITY", timing: "immediate", why: "Navigation: it opens the wake-try page." },
  { id: "settings.display-preview", title: "DISPLAY PREVIEW", timing: "immediate", why: "Navigation: it opens a preview." },
  {
    id: "settings.public-link",
    title: "SIGN OUT · CONNECT ONLINE",
    timing: "immediate",
    why:
      "Session state. Measured on the path (LinkCoordinator.logoutPublic): it revokes the session and " +
      "clears the stored credentials, and keeps the history, the queued messages, the favourites and " +
      "the wake phrase. Signing in again restores what it changed.",
  },
  { id: "settings.install-update", title: "UPDATE", timing: "immediate", why: "The platform installer asks its own question after the press, and the APK is already downloaded." },
  { id: "history.clear", title: "CLEAR <recipient>", timing: "deliberate", why: "It destroys the conversation on this phone, and no second press brings it back." },
  { id: "wake-try.try-phrase", title: "TRY <PHRASE>", timing: "immediate", why: "Trying again is the whole point of the page." },
  { id: "settings.wake-debug", title: "WAKE DEBUG", timing: "immediate", why: "Navigation: it opens the wake-debug page." },
  { id: "debug.wake-watching", title: "WATCHING · NOT WATCHING", timing: "immediate", why: recovers("A toggle on the wake-debug page") },
  { id: "debug.wake-export", title: "EXPORT", timing: "immediate", why: "It writes one debug file the wearer asked for; nothing on the page changes and nothing is sent." },
  { id: "dev.host-preview", title: "HOST PREVIEW", timing: "immediate", why: "Navigation." },
  { id: "dev.product-ports", title: "PRODUCT PORTS", timing: "immediate", why: "Navigation." },
  { id: "chrome.open-settings", title: "SETTINGS", timing: "immediate", why: "Navigation." },
  { id: "home.speak-replies", title: "READ REPLIES", timing: "immediate", why: recovers("A home-page toggle, writing the same preference Settings writes") },
  { id: "home.wake-toggle", title: "<phrase>", timing: "immediate", why: recovers("A toggle on the home page, writing the same preference Settings writes") },
  { id: "home.voice-message", title: "VOICE MESSAGE", timing: "immediate", why: "Navigation: it opens the capture screen and sends nothing." },
  { id: "home.reply", title: "REPLY", timing: "immediate", why: "Navigation: it opens the reply and sends nothing." },
  { id: "home.history", title: "HISTORY", timing: "immediate", why: "Navigation." },
  { id: "home.recipient", title: "RECIPIENT", timing: "immediate", why: "Navigation: it opens the picker." },
  { id: "recipients.select", title: "<recipient>", timing: "immediate", why: recovers("A choice") },
  { id: "recipients.favorites", title: "FAVORITES", timing: "immediate", why: "Navigation: it opens editing." },
  { id: "conversation.play-turn", title: "<turn>", timing: "immediate", why: recovers("Playback") },
  { id: "conversation.open-link", title: "OPEN LINK", timing: "immediate", why: "Navigation, out to a browser." },
  { id: "conversation.open-turn", title: "<conversation turn>", timing: "immediate", why: "Navigation: it opens the turn." },
];

/**
 * The gestures that declare NO timing, because they are not discrete actions.
 *
 * product-spec says it beside the two words: a gesture whose duration IS the content is neither
 * kind. Push-to-talk holds to record and sends on release, so its hold confirms nothing; calling it
 * deliberate would promise a gate it does not have, and calling it immediate would deny the hold
 * that is doing the work.
 */
export const linkGesturesWithoutATiming: readonly { readonly id: string; readonly title: string; readonly why: string }[] = [
  {
    id: "capture.push-to-talk",
    title: "PUSH TO TALK",
    why: "Held to record and released to send: the duration is the message, not a confirmation of it.",
  },
];
