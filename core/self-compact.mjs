// One-shot self-compaction requests. A pane at a stage boundary asks to be
// compacted when its turn ends (`amux compact --self`); the bridge runs the
// request with the pause guards (channels/pause-compact.mjs), or before a
// waiting delivery (core/context-maintenance.mjs beforeWork).

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AT_WORK_COMPACT_TOKENS, CONTEXT_COST_POLICY, PAUSE_COMPACT_POLICY } from "../policies/context-cost.mjs";
import { QUOTA_PARK_ORIGIN } from "./quota-park.mjs";
import { QUOTA_WIND_DOWN_ORIGIN } from "./quota-wind-down.mjs";

// Below about 80k a compact saves less than it costs. A request a pane files through the CLI comes from a pane at work
// and runs only above 400k (Row 214, 16 Nov 2026, policies/context-cost.mjs); the requests the bridge files for its own
// rules carry one of bridgeOrigins and keep 80k. One per 30 minutes is the pause rule's spacing; a request still blocked
// after two hours is stale.
/** WHAT: Defines when a self-request is worth a compact and how long it waits. WHY: Keeps a pane at work on 400k and the bridge's own requests on 80k. */
export const SELF_COMPACT_POLICY = Object.freeze({
  minTokens: CONTEXT_COST_POLICY.maxTokens,
  paneTokens: AT_WORK_COMPACT_TOKENS,
  bridgeOrigins: Object.freeze([QUOTA_PARK_ORIGIN, QUOTA_WIND_DOWN_ORIGIN]),
  spacingMs: PAUSE_COMPACT_POLICY.spacingMs,
  expiresMs: 2 * 60 * 60_000,
});

const DEFAULT_DIR = join(homedir(), ".agentmux", "self-compact");
const fileFor = (dir, agent, pane) => join(dir, `${agent}--p${pane}.json`);

// The stored `origin` field tells the two apart, never the handoff: deep:0's requests of 16 Nov had none and it worked on.
// An origin outside bridgeOrigins, or none, is a pane's.
/** WHAT: Checks whether a pane, not the bridge, filed a request. WHY: Keeps the CLI and the bridge on one explicit field for whose request it is. */
export const isPaneRequest = (request, policy = SELF_COMPACT_POLICY) => !policy.bridgeOrigins.includes(request?.origin);

/** WHAT: Maps a request to the size its compact must exceed. WHY: Keeps the CLI and the bridge on one limit per kind of request. */
export const selfCompactFloor = (request, policy = SELF_COMPACT_POLICY) =>
  isPaneRequest(request, policy) ? policy.paneTokens : policy.minTokens;

/** WHAT: Formats why a pane's compact is not run at this size. WHY: Keeps every such answer on the same plain words and the idle rules' own numbers. */
export function atWorkDetail(tokens, policy = SELF_COMPACT_POLICY) {
  const size = Number.isFinite(tokens) ? `${tokens} tokens is not above ${policy.paneTokens}` : `the context size is unknown, so not proven above ${policy.paneTokens}`;
  return `${size}. This is not an error: a pane at work is not compacted under that (owner's decision 16 Nov 2026), and AMUX compacts the pane by itself `
    + `once it has rested (Claude after ${CONTEXT_COST_POLICY.idleMs / 60_000} min from ${CONTEXT_COST_POLICY.maxTokens / 1000}k, `
    + `Codex after ${PAUSE_COMPACT_POLICY.codexIdleMs / 60_000} min from ${PAUSE_COMPACT_POLICY.codexMinTokens / 1000}k)`;
}

// One comparison at the CLI, at the turn end and before a delivery: a pane's request runs only above its 400k, as the
// turn-end size rule does, so no size is admitted at one place and refused at another.
/** WHAT: Checks whether a request to be compacted may be stored or run now. WHY: Prevents the CLI from admitting a size the bridge would refuse. */
export function selfCompactAdmission({ tokens, lastCompactAt = null, now, origin = null }, policy = SELF_COMPACT_POLICY) {
  if (!Number.isFinite(tokens)) return { ok: false, cell: "unknown-context", detail: "the pane's context size is unknown" };
  if (isPaneRequest({ origin }, policy)) {
    if (!(tokens > policy.paneTokens)) return { ok: false, cell: "at-work", detail: atWorkDetail(tokens, policy) };
  } else if (tokens < policy.minTokens) {
    return { ok: false, cell: "under-budget", detail: `${tokens} tokens is under ${policy.minTokens}; a compact would cost more than it saves` };
  }
  if (Number.isFinite(lastCompactAt) && now - lastCompactAt < policy.spacingMs) {
    return { ok: false, cell: "spacing", detail: `compacted ${Math.round((now - lastCompactAt) / 60_000)} min ago; at most one per ${policy.spacingMs / 60_000} min` };
  }
  return { ok: true };
}

/** WHAT: Formats a self-request outcome for the pane's channel. WHY: Keeps a discarded continuation distinct from a resumed turn. */
export function formatSelfCompactNotice(paneKey, { outcome, tokens = null, detail = "", focus = "", continuationSuperseded = false, compactCause = null }) {
  if (continuationSuperseded) {
    return `Self-compact **${paneKey}**: the saved continuation was not queued because newer input or a new session superseded it.`;
  }
  if (outcome === "compacted") {
    return `Self-compact **${paneKey}** at the end of its turn${Number.isFinite(tokens) ? ` (${tokens} tokens)` : ""}${focus ? `, focus: ${focus}` : ""}.${compactCause ? ` Cause: ${compactCause}.` : ""}`;
  }
  return `Self-compact **${paneKey}** ${outcome}: ${detail}`;
}

/** WHAT: Builds the request store shared by the CLI and the bridge. WHY: Keeps the file format in one place and injectable in tests. */
export function createSelfCompactStore({ dir = DEFAULT_DIR, now = Date.now, policy = SELF_COMPACT_POLICY } = {}) {
  function clear(agent, pane) { rmSync(fileFor(dir, agent, pane), { force: true }); }

  return {
    /** Stores one request when admitted. A second request replaces the first, so the latest focus wins. */
    request({ agent, pane, focus = "", tokens, lastCompactAt = null, continuation = "", identity = null, cursor = null, origin = null }) {
      const admission = selfCompactAdmission({ tokens, lastCompactAt, now: now(), origin }, policy);
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
