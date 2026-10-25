import { createHash } from "node:crypto";
import { authoredPromptText, isSystemNoiseDirective } from "./system-noise.mjs";
import { observedAskOrigin } from "./ask-source-evidence.mjs";

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
 * …], [file attached: …], the voice prefix and the Link marker line are his (humanMessageText takes that line off his
 * words); [from …] is an agent's brief and inferAskOrigin already tells it. core/search-human-words.test.mjs finds
 * each tag in its sender's file.
 * WHAT: Names every bracket tag amux types into a pane, with the file that sends it.
 * WHY: Keeps amux's own notices from counting as a person's messages.
 */
export const AMUX_PANE_TAGS = Object.freeze([
  ["[stall-watch]", "~/lsrc/.agents/0/tools/stall-watch.py"],
  ["[keeper", "bin/task-keeper-cron.sh"],
  ["[fleet-watch", "bin/fleet-progress-cron.sh"],
  ["[board-curator", "bin/board-curator-cron.sh"],
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
  ["[quiet]", "core/quiet-plan.mjs"],
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
    && observedAskOrigin(ask, inferAskOrigin) === "human"
    && !AMUX_TAG_AT_START.test(authoredPromptText(ask.verbatim));
}

const VOICE_TAG = /^\[transcribed voice[^\]]*\]\s*/u;
// His message from the phone reaches a pane as one marker line with the turn's id, then his words (channels/link-connector.mjs, linkTurnPrompt).
const LINK_TURN_MARKER = /^\[amux-link-turn:[^\]\n]*\][ \t]*(?:\r?\n|$)/u;

// The tags in front of his words are the Link marker line, which comes first, and the voice prefix.
/** WHAT: Returns the words of one of his messages and whether he spoke them. WHY: Keeps every word of his and drops only the bridge's own tags in front of them. */
export function humanMessageText(ask) {
  const authored = authoredPromptText(ask.verbatim).replace(LINK_TURN_MARKER, "");
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

// The rule of coalesceAskLedger: a pane-hook row is the copy of a delivery of the same agent, pane and authored text within a quarter of an hour.
/** WHAT: Names the longest gap between a delivery and the pane's copy of it. WHY: Keeps the copy rule of coalesceAskLedger and of the sync on one number. */
export const COPY_MATCH_MS = 15 * 60_000;

/** WHAT: Names the authored text of an ask by a short hash. WHY: Keeps a delivery and the pane's copy of it matchable without keeping any words. */
export const askTextHash = (ask) => createHash("sha256").update(authoredPromptText(ask.verbatim)).digest("hex").slice(0, 16);

const copyKey = ({ agent, pane, hash }) => `${agent}\u0000${pane}\u0000${hash}`;
const isLinkTurn = (ask) => LINK_TURN_MARKER.test(authoredPromptText(ask.verbatim));

/**
 * Returns null for a pane-hook row and for a delivery of his. His Link turn is one: the connector passes no source, so
 * its row says "unknown". A delivery whose words would not pass for his if typed in a pane (an agent's brief, a notice
 * with its tag) needs no entry either: the pane's copy of it fails isHumanAsk by its words.
 * WHAT: Describes a delivery no person wrote by what the pane's copy of it carries.
 * WHY: Keeps the pane's copy of what amux typed from passing for a message he typed.
 */
export function automatedDeliveryOf(ask) {
  if (ask.source === "pane-hook" || isHumanAsk(ask) || isLinkTurn(ask)) return null;
  if (!isHumanAsk({ source: "pane-hook", verbatim: ask.verbatim })) return null;
  return { agent: ask.agent, pane: ask.pane, hash: askTextHash(ask), ms: Date.parse(ask.ts) };
}

/**
 * `delivered` lists deliveries seen outside `asks` (automatedDeliveryOf), such as the ones a sync read before. The
 * pane's hook records what amux typed (a self-compact continuation, a script's message, a delivery notice) like a
 * prompt a person typed, so only the delivery it copies tells them apart. Every copy within the quarter hour goes,
 * not one per delivery.
 * WHAT: Returns the pane-hook rows among `asks` that copy a delivery no person wrote.
 * WHY: Keeps what amux typed into a pane from counting as his.
 */
export function automatedCopies(asks, delivered = []) {
  const times = new Map();
  for (const entry of [...delivered, ...asks.map(automatedDeliveryOf).filter(Boolean)]) {
    const key = copyKey(entry);
    if (times.has(key)) times.get(key).push(entry.ms); else times.set(key, [entry.ms]);
  }
  const copies = new Set();
  if (!times.size) return copies;
  for (const ask of asks) {
    if (ask.source !== "pane-hook") continue;
    const ms = Date.parse(ask.ts);
    const sent = times.get(copyKey({ agent: ask.agent, pane: ask.pane, hash: askTextHash(ask) })) || [];
    if (sent.some((at) => Math.abs(ms - at) <= COPY_MATCH_MS)) copies.add(ask);
  }
  return copies;
}

/**
 * `earlier` lists the keys of messages already counted outside `asks`, such as the ones a sync placed before, and
 * `delivered` the deliveries a sync read before (automatedDeliveryOf). A delivery and its pane-hook copy are one message,
 * so pass asks with their copies merged (readWindow does).
 * WHAT: Returns the asks a person wrote, leaving out amux's notices, delivery copies and repeated prompts.
 * WHY: Keeps Dream's answer statistic and the search of his words from counting automation as his.
 */
export function humanAsksOf(asks, { earlier = [], delivered = [] } = {}) {
  const copies = automatedCopies(asks, delivered);
  const human = asks.filter((ask) => isHumanAsk(ask) && !copies.has(ask));
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
