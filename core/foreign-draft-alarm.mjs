// Reports a foreign composer draft, never submits or removes it.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { composerDraft } from "./dialects.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";

/** WHAT: Names durable draft episodes. WHY: Keeps first sight and sent notices across bridge restarts. */
export const FOREIGN_DRAFT_STATE_KEY = "foreign_draft_alarm_v1";
/** WHAT: Defines the delay before reporting a foreign draft. WHY: Keeps short composer edits from alerting the dispatcher. */
export const FOREIGN_DRAFT_AFTER_MS = 10 * 60_000;
const PASTE_LOOKBACK_MS = 2 * 60 * 60_000;
const IN_FLIGHT = new Set(["drafted", "pasting", "submitting", "submitted"]);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const preview = (text) => String(text).split(/\r?\n/u).slice(0, 3).join("\n").slice(0, 300);
const collapsedPaste = (draft) => /^\[Pasted text #\d+ \+(\d+) lines\]$/u.exec(draft);

/**
 * WHAT: Reads one Claude draft and checks whether waiting jobs or the injected predicate own it.
 * WHY: Keeps delivery-owned drafts out of alerts while preserving a draft's age through queue changes.
 */
export function foreignDraftEvidence({ engine = "claude", agentName, pane, screen, jobs = [], ownsDraft = () => false } = {}) {
  if (engine !== "claude") return null;
  const draft = composerDraft(screen);
  if (!draft) return null;
  const live = jobs.filter((job) => !TERMINAL_DELIVERY_STATES.has(job.status));
  const owned = live.some((job) => job.draftOwned || IN_FLIGHT.has(job.status))
    || ownsDraft({ agentName, pane, draft, jobs: live });
  return { draft, episode: hash(draft), waiting: live.length, foreign: live.length > 0 && !owned };
}

/**
 * WHAT: Reads the preview of exactly one recent stored paste matching the collapsed line count.
 * WHY: Prevents unrelated cached text from being presented as the draft's content.
 */
export async function storedPastePreview({ draft, profileHome, firstSeenAt }) {
  const match = collapsedPaste(draft);
  if (!match || !profileHome) return null;
  const directory = join(profileHome, "paste-cache");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{16}\.txt$/u.test(entry.name)) continue;
    const path = join(directory, entry.name);
    let content;
    try {
      const info = await stat(path);
      if (info.mtimeMs < firstSeenAt - PASTE_LOOKBACK_MS || info.mtimeMs > firstSeenAt) continue;
      content = await readFile(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue; // Cache eviction during a read is not evidence.
      throw error;
    }
    if (content.split(/\r?\n/u).length !== Number(match[1]) + 1) continue;
    if (hash(content).slice(0, 16) !== entry.name.slice(0, 16)) continue;
    candidates.push(preview(content));
    if (candidates.length > 1) return null;
  }
  return candidates[0] ?? null;
}

function draftNotice({ key, evidence, firstSeenAt, now, stored }) {
  const minutes = Math.max(0, Math.floor((now - firstSeenAt) / 60_000));
  const paste = collapsedPaste(evidence.draft)
    ? ` Stored paste, first lines: ${stored === null ? "no unique stored copy" : JSON.stringify(stored)}.` : "";
  return `[amux] ${key}: its composer has held a draft amux did not type for ${minutes} min; ${evidence.waiting} messages wait. `
    + `Draft: ${JSON.stringify(preview(evidence.draft))}.${paste} amux never clears it: send or clear it in the pane.`;
}

/**
 * WHAT: Tracks Claude drafts durably and queues one dispatcher notice per episode after ten minutes.
 * WHY: Prevents silent delivery stalls without touching the pane's composer or process.
 */
export function createForeignDraftAlarm({ target, panes, observe, notify, state, ownsDraft = () => false,
  now = Date.now, afterMs = FOREIGN_DRAFT_AFTER_MS, readStoredPaste = storedPastePreview, log = () => {} }) {
  if (!target || typeof panes !== "function" || typeof observe !== "function" || typeof notify !== "function"
      || !state?.get || !state?.set || typeof ownsDraft !== "function") {
    throw new Error("foreign draft alarm requires target, panes, observe, notify, state and ownsDraft");
  }
  let running = null;

  async function check() {
    const episodes = { ...(state.get(FOREIGN_DRAFT_STATE_KEY, {}) || {}) };
    const configured = new Set();
    const reported = [];
    const save = () => state.set(FOREIGN_DRAFT_STATE_KEY, { ...episodes });
    for (const pane of panes()) {
      if (pane.engine !== "claude") continue;
      configured.add(pane.key);
      let observation;
      try { observation = await observe(pane); }
      catch (error) { log(`${pane.key}: observation failed: ${error.message}`); continue; }
      const evidence = foreignDraftEvidence({ ...observation, ...pane, ownsDraft });
      if (!evidence) {
        if (episodes[pane.key]) { delete episodes[pane.key]; save(); }
        continue;
      }
      if (episodes[pane.key]?.episode !== evidence.episode) {
        episodes[pane.key] = { episode: evidence.episode, firstSeenAt: now(), notifiedAt: null };
        save(); // The first sight must survive even if enqueue or the next pane read fails.
      }
      const episode = episodes[pane.key];
      if (!evidence.foreign || episode.notifiedAt !== null || now() - episode.firstSeenAt < afterMs) continue;
      let stored = null;
      if (collapsedPaste(evidence.draft)) {
        try { stored = await readStoredPaste({ draft: evidence.draft, profileHome: observation.profileHome, firstSeenAt: episode.firstSeenAt }); }
        catch (error) { log(`${pane.key}: stored paste unavailable: ${error.message}`); }
      }
      await notify(draftNotice({ key: pane.key, evidence, firstSeenAt: episode.firstSeenAt, now: now(), stored }),
        `foreign-draft:${pane.key}:${evidence.episode}`);
      episodes[pane.key] = { ...episode, notifiedAt: now() };
      save(); // Retrying a crash before this write reuses the queue's idempotency key.
      reported.push(pane.key);
      log(`${pane.key}: foreign draft reported to ${target}, ${evidence.waiting} messages waiting`);
    }
    for (const key of Object.keys(episodes)) {
      if (!configured.has(key)) { delete episodes[key]; save(); }
    }
    return reported;
  }

  return { tick: () => {
    running ??= check().finally(() => { running = null; });
    return running;
  } };
}
