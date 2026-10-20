import { createHash } from "node:crypto";
import { authoredPromptText, isSystemNoiseDirective } from "./system-noise.mjs";

const AUTOMATION_SOURCES = new Set([
  "auto-compact",
  "amux:compact",
  "dream",
  "drift-guard",
  "suggestions-watchdog",
  "quota-recovery",
  "codex-capacity-recovery",
  "codex-limit-recovery",
  "fleet-restart-recovery",
]);

/** WHAT: Labels who originated a prompt. WHY: `amux asks` defaults to human/operator asks without hiding agent traffic irreversibly. */
export function inferAskOrigin({
  source = "unknown",
  sender = null,
  prompt = "",
} = {}) {
  if (isSystemNoiseDirective(prompt)) return "system";
  if (sender || /^\[from\s+[^\]]+\]/iu.test(authoredPromptText(prompt))) return "agent";
  if (source === "discord" || source === "pane-hook") return "human";
  if (AUTOMATION_SOURCES.has(source)) return "system";
  // A plain prompt entered through `amux <agent> ...` outside another pane is
  // an operator ask. Treat it like human input; `[from ...]` handled agents.
  return "human";
}

/** WHAT: Names the ask sources a person answers through. WHY: Keeps the answer statistic and the search of his words on one list. */
const HUMAN_ASK_SOURCES = new Set(["discord", "pane-hook"]);

/**
 * A prompt that starts with one of these is amux's notice, never a person's message (docs/DESIGN-search-daemon.md,
 * I-2b). The pane-hook records it like a typed prompt, so only its start tells it apart. `sender` is a path in this
 * repository, or under ~/ for a script outside it. Left out on purpose: tags that follow a message ([amux
 * orientation, memory …], [amux leader review], [amux-phone-turn:…]) cannot start a prompt; his own [image attached:
 * …], [file attached: …] and the voice prefix are his; [from …] is an agent's brief and inferAskOrigin already tells
 * it. core/search-human-words.test.mjs finds each tag in its sender's file.
 * WHAT: Names every bracket tag amux types into a pane, with the file that sends it.
 * WHY: Keeps amux's own notices from counting as a person's messages.
 */
export const AMUX_PANE_TAGS = Object.freeze([
  ["[stall-watch]", "~/lsrc/.agents/0/tools/stall-watch.py"],
  ["[keeper", "bin/task-keeper-cron.sh"],
  ["[fleet-watch", "bin/fleet-progress-cron.sh"],
  ["[board-curator", "bin/board-curator-cron.sh"],
  ["[amux-link-turn", "channels/link-connector.mjs"],
  ["[AMUX-SLEEP-CHECK", "cli/sleep.mjs"],
  ["[AMUX leveransstopp", "core/delivery-handoff.mjs"],
  ["[AMUX delivery outcome]", "core/delivery-notices.mjs"],
  ["[AMUX DREAM", "core/dream-owner.mjs"],
  ["[AMUX QUOTA PARK", "core/quota-park.mjs"],
  ["[AMUX AUTOMATIC QUOTA RECOVERY", "core/claude-quota-recovery.mjs"],
  ["[AMUX AUTOMATIC CRASH RECOVERY", "core/fleet-restart.mjs"],
  ["[SUGGESTIONS HUMAN COMMENT HANDOFF]", "core/suggestions-comment-bridge.mjs"],
  ["[BOARD CHECK", "core/suggestions-watchdog-alerts.mjs"],
  ["[SRC-0108]", "core/suggestions-watchdog-fallback.mjs"],
  ["[SRC-0114]", "core/suggestions-watchdog-outbox.mjs"],
  ["[drift-guard]", "core/reminder-state.mjs"],
  ["[idle-capacity]", "core/idle-capacity-alarm.mjs"],
  ["[model-watch]", "core/model-watch.mjs"],
  ["[pause-compact]", "core/pause-compact.mjs"],
  ["[krasch-recovery]", "core/revive.mjs"],
  ["[stop-all-recovery]", "core/revive.mjs"],
].map(([tag, sender]) => Object.freeze({ tag, sender })));

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
// A tag ends where a letter or digit would go on, so "[keeper, automatisk]" is a notice and "[keepers]" is text.
const AMUX_TAG_AT_START = new RegExp(`^(?:${AMUX_PANE_TAGS.map(({ tag }) => escapeRegex(tag)).join("|")})(?![\\p{L}\\p{N}])`, "u");

/** WHAT: Checks whether a ledger ask is a message a person wrote. WHY: Keeps agents' briefs, wrappers, automation and amux's own notices out of everything that counts or quotes his words. */
export function isHumanAsk(ask) {
  return HUMAN_ASK_SOURCES.has(ask?.source)
    && inferAskOrigin({ source: ask.source, sender: ask.sender, prompt: ask.verbatim }) === "human"
    && !AMUX_TAG_AT_START.test(authoredPromptText(ask.verbatim));
}

const VOICE_TAG = /^\[transcribed voice[^\]]*\]\s*/u;

/** WHAT: Returns the words of one of his messages and whether he spoke them. WHY: Keeps every word of his and drops only the bridge's own tag in front of a transcript. */
export function humanMessageText(ask) {
  const authored = authoredPromptText(ask.verbatim);
  const spoken = VOICE_TAG.test(authored);
  return { text: spoken ? authored.replace(VOICE_TAG, "") : authored, spoken };
}

// A prompt of this many characters, typed this many times, is a loop or a script and not a person (I-2b).
const REPEAT_MIN_CHARS = 40;
const REPEAT_COPIES = 3;

/** WHAT: Names a text that can count as repeated, or null for one under 40 characters. WHY: Keeps short answers such as "ja, kör" from ever counting as a repeated prompt. */
export function repeatKeyOfText(text) {
  return text.length >= REPEAT_MIN_CHARS ? createHash("sha256").update(text).digest("hex").slice(0, 16) : null;
}

/** WHAT: Names the repeated-text key of one ask, from his words without the voice tag. WHY: Keeps the 40 characters and the copies counted on what he said, not on the bridge's prefix. */
export const repeatKeyOf = (ask) => repeatKeyOfText(humanMessageText(ask).text);

/** WHAT: Returns the keys that three or more of the given keys share. WHY: Keeps Dream's statistic and the day files from defining a repeated prompt twice. */
export function repeatedKeys(keys) {
  const counts = new Map();
  for (const key of keys) if (key) counts.set(key, (counts.get(key) || 0) + 1);
  return new Set([...counts].filter(([, copies]) => copies >= REPEAT_COPIES).map(([key]) => key));
}

/**
 * `earlier` lists the keys of messages already counted outside `asks`, such as the ones a sync placed before. A delivery
 * and its pane-hook copy are one message, so pass asks with their copies merged (readWindow does).
 * WHAT: Returns the asks a person wrote, without amux's notices and prompts repeated three times.
 * WHY: Keeps Dream's answer statistic and the search of his words from counting automation as his.
 */
export function humanAsksOf(asks, { earlier = [] } = {}) {
  const human = asks.filter(isHumanAsk);
  const keys = human.map(repeatKeyOf);
  const repeated = repeatedKeys([...earlier, ...keys]);
  return human.filter((ask, index) => !repeated.has(keys[index]));
}

const OWNER_CHANNELS = new Set(["discord", "voice-pwa"]);

/** WHAT: Checks whether a person sent the job from their own channel. WHY: Lets a pane whose compact failed take its owner's message while automatic work waits. */
export function isOwnerChannelJob(job) {
  return OWNER_CHANNELS.has(job?.source)
    && inferAskOrigin({ source: job.source, sender: job.metadata?.sender, prompt: job.text || "" }) === "human";
}
