// One-shot self-compaction requests. A pane at a stage boundary asks to be
// compacted when its turn ends (`amux compact --self`); the bridge runs the
// request with the pause guards (channels/pause-compact.mjs), or before a
// waiting delivery (core/context-maintenance.mjs beforeWork).

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONTEXT_COST_POLICY, PAUSE_COMPACT_POLICY } from "../policies/context-cost.mjs";

/**
 * WHAT: Defines when a self-request is worth a compact and how long it waits.
 * WHY: Below about 80k a compact saves less than it costs; one per 30 minutes is the pause rule's spacing;
 * a request still blocked after two hours is stale.
 */
export const SELF_COMPACT_POLICY = Object.freeze({
  minTokens: CONTEXT_COST_POLICY.maxTokens,
  spacingMs: PAUSE_COMPACT_POLICY.spacingMs,
  expiresMs: 2 * 60 * 60_000,
});

const DEFAULT_DIR = join(homedir(), ".agentmux", "self-compact");
const fileFor = (dir, agent, pane) => join(dir, `${agent}--p${pane}.json`);

/** WHAT: Decides whether a pane may ask to be compacted now. WHY: Refuses at once what the bridge would refuse later. */
export function selfCompactAdmission({ tokens, lastCompactAt = null, now }, policy = SELF_COMPACT_POLICY) {
  if (!Number.isFinite(tokens)) return { ok: false, cell: "unknown-context", detail: "the pane's context size is unknown" };
  if (tokens < policy.minTokens) {
    return { ok: false, cell: "under-budget", detail: `${tokens} tokens is under ${policy.minTokens}; a compact would cost more than it saves` };
  }
  if (Number.isFinite(lastCompactAt) && now - lastCompactAt < policy.spacingMs) {
    return { ok: false, cell: "spacing", detail: `compacted ${Math.round((now - lastCompactAt) / 60_000)} min ago; at most one per ${policy.spacingMs / 60_000} min` };
  }
  return { ok: true };
}

/** WHAT: Words how a self-request ended for the pane's channel. WHY: Mirrors it like the automatic compactions, from one place. */
export function formatSelfCompactNotice(paneKey, { outcome, tokens = null, detail = "", focus = "" }) {
  if (outcome === "compacted") {
    return `Self-compact **${paneKey}** at the end of its turn${Number.isFinite(tokens) ? ` (${tokens} tokens)` : ""}${focus ? `, focus: ${focus}` : ""}.`;
  }
  return `Self-compact **${paneKey}** ${outcome}: ${detail}`;
}

/** WHAT: Builds the request store shared by the CLI and the bridge. WHY: Keeps the file format in one place and injectable in tests. */
export function createSelfCompactStore({ dir = DEFAULT_DIR, now = Date.now, policy = SELF_COMPACT_POLICY } = {}) {
  function clear(agent, pane) { rmSync(fileFor(dir, agent, pane), { force: true }); }

  return {
    /** Stores one request when admitted. A second request replaces the first, so the latest focus wins. */
    request({ agent, pane, focus = "", tokens, lastCompactAt = null, continuation = "", identity = null, cursor = null, origin = null }) {
      const admission = selfCompactAdmission({ tokens, lastCompactAt, now: now() }, policy);
      if (!admission.ok) return admission;
      const request = { agent, pane, focus: String(focus || ""), tokens, requestedAt: new Date(now()).toISOString(), ...(origin ? { origin } : {}) };
      if (continuation) {
        if (!identity?.sessionId || !identity?.path || !Number.isFinite(cursor?.positions?.[identity.path])) {
          throw new Error("self-compact continuation requires the exact session and checkpoint cursor");
        }
        request.continuation = String(continuation);
        request.identity = identity;
        request.cursor = cursor;
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = fileFor(dir, agent, pane);
      writeFileSync(`${path}.tmp`, `${JSON.stringify(request)}\n`, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      return { ok: true, request };
    },
    /** Reads a pane's pending request; an expired one is removed and reported once through onExpired. */
    read(agent, pane, { onExpired = () => {} } = {}) {
      let request;
      try { request = JSON.parse(readFileSync(fileFor(dir, agent, pane), "utf8")); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
      if (now() - Date.parse(request.requestedAt) > policy.expiresMs) {
        clear(agent, pane);
        onExpired(request);
        return null;
      }
      return request;
    },
    clear,
    /** Lists every pending request, oldest first, for `amux compact --dry`. */
    list() {
      let names = [];
      try { names = readdirSync(dir).filter((name) => name.endsWith(".json")); } catch { return []; }
      return names.map((name) => { try { return JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { return null; } })
        .filter(Boolean).sort((left, right) => Date.parse(left.requestedAt) - Date.parse(right.requestedAt));
    },
  };
}
