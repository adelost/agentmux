import { component, expect, feature } from "bdd-vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSelfCompactStore } from "./self-compact.mjs";
import { createContextMaintenance } from "./context-maintenance.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { createPauseCompact } from "../channels/pause-compact.mjs";
import { captureJsonlAppendCursor } from "./jsonl-append-cursor.mjs";
import { fenceSelfCompactJobs } from "./self-compact-resume.mjs";

const NOW = Date.parse("2026-10-12T16:18:07.172Z");
const HANDOFF = "Continue from the clean pushed checkpoint 9cd1f581. Read the saved task. Återkör inte färdiga prov. No provider or deploy.";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-compact-resume-")), path = join(root, "rollout.jsonl");
  writeFileSync(path, "");
  const append = event => appendFileSync(path, JSON.stringify(event) + "\n");
  const data = {}, calls = [], notices = [];
  const state = { get: (key, fallback) => data[key] ?? fallback, set: (key, value) => { data[key] = value; } };
  const identity = { sessionId: "same-session", path };
  const queue = createDeliveryQueue({ rootDir: join(root, "queue"), now: () => NOW });
  const requests = createSelfCompactStore({ dir: join(root, "requests"), now: () => NOW - 90_000 });
  requests.request({ agent: "lsrc", pane: 4, tokens: 443_000, focus: HANDOFF, continuation: HANDOFF,
    identity: { ...identity, engine: "codex", dir: root }, cursor: captureJsonlAppendCursor("self-compact-request-v1", [path]) });
  const deps = { state, queue, selfRequests: requests, now: () => NOW, identityFor: () => identity,
    resolveTarget: () => ({ engine: "codex", dir: root }), activityFor: () => NOW - 90_000,
    agent: { paneProcessState: async () => ({ running: true }), getContext: async () => ({ tokens: 443_000 }),
      isBusy: async () => false, promptTransportState: async () => ({ state: "empty-idle", dialect: "codex" }),
      captureScreen: async () => "› " },
    compactFor: () => async () => { calls.push("compact"); append({ type: "compacted" });
      return { ok: true, compactBoundary: true, sessionId: identity.sessionId }; },
  };
  const poll = () => createPauseCompact({ state, contextMaintenance: createContextMaintenance(deps), selfRequests: requests,
    modes: { codex: "on" }, now: () => NOW, identityFor: () => identity, backgroundFor: { codex: () => null },
    journalCompactFor: () => null, record: () => {}, notify: async (...args) => notices.push(args) }).consider({
    agentConfig: { name: "lsrc", orchestrator: 3 }, pane: 4, engine: "codex", paneDir: root,
    status: "idle", contextTokens: 443_000, lastActivityMs: NOW - 90_000,
  });
  return { root, path, identity, queue, requests, deps, append, calls, notices, poll,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

feature("a checkpoint compact continues its own saved task", () => {
  component("the actual lsrc:4 pause request compacts and queues its handoff without a later external delivery", {
    given: ["the sanitized 16:18 checkpoint request at 443k and no waiting input", fixture],
    when: ["two bridge polls see the safe pause", async fx => { await fx.poll(); await fx.poll(); return fx.queue.list("lsrc", 4); }],
    then: ["one native compact and one exact durable handoff, not an idle pane", (jobs, fx) => {
      expect(fx.calls).toEqual(["compact"]);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ text: HANDOFF, kind: "prompt", source: "self-compact", attempts: 0 });
      // Input can arrive between the final producer check and enqueue. The
      // physical guard must not refresh its cursor past that input.
      expect(jobs[0].metadata.selfCompactContinuation.cursor.positions[fx.path]).toBe(0);
      expect(fx.requests.read("lsrc", 4)).toBeNull();
    }], cleanup: fx => fx.cleanup(),
  });
  component("a queue failure after the compact survives a bridge restart without another compact", {
    given: ["the same request and one failed durable enqueue", () => {
      const fx = fixture(), enqueue = fx.queue.enqueue;
      fx.queue.enqueue = () => { throw new Error("disk temporarily unavailable"); };
      return { ...fx, enqueue };
    }],
    when: ["enqueue fails, then a fresh controller retries at the next pause", async fx => {
      await fx.poll().catch(() => {});
      const retained = fx.requests.read("lsrc", 4);
      fx.queue.enqueue = fx.enqueue;
      await fx.poll();
      return { retained, jobs: fx.queue.list("lsrc", 4) };
    }],
    then: ["the saved request was retained and resumes once from the existing verified boundary", ({ retained, jobs }, fx) => {
      expect(retained).not.toBeNull(); expect(fx.calls).toEqual(["compact"]); expect(jobs).toHaveLength(1);
    }], cleanup: fx => fx.cleanup(),
  });
  component("new authored input supersedes the saved handoff rather than reviving the old task", {
    given: ["a checkpoint request followed by Mattias changing the task", () => {
      const fx = fixture(); fx.append({ type: "event_msg", payload: { type: "user_message", message: "Stop. Work on the new request." } }); return fx;
    }],
    when: ["the next safe pause is considered", fx => fx.poll()],
    then: ["no compact or continuation for the superseded request", (_, fx) => {
      expect(fx.calls).toEqual([]); expect(fx.queue.list("lsrc", 4)).toEqual([]); expect(fx.requests.read("lsrc", 4)).toBeNull();
    }], cleanup: fx => fx.cleanup(),
  });
  for (const scenario of ["session-change", "working", "dialog", "new-input", "submitted"]) {
    component(`${scenario} protects the post-compact continuation at the physical boundary`, {
      given: ["a verified compact and its one pending handoff", fixture],
      when: ["the pane changes before the first submit", async fx => {
        await fx.poll();
        let job = fx.queue.list("lsrc", 4)[0];
        if (scenario === "session-change") fx.identity.sessionId = "another-session";
        if (scenario === "new-input") fx.append({ type: "response_item", payload: { type: "message", role: "user",
          content: [{ type: "input_text", text: "Ny fråga, inte den gamla uppgiften." }],
          internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } } });
        if (scenario === "submitted") job = fx.queue.update(job, { status: "submitted", attempts: 1 });
        await fenceSelfCompactJobs({ agentName: "lsrc", pane: 4, queue: fx.queue, now: () => NOW, identityFor: () => fx.identity,
          log: () => {}, terminalizeNotSent: async candidate => { fx.queue.update(candidate, { status: "cancelled" }); },
          agent: { isBusy: async () => scenario === "working", promptTransportState: async () => ({ state: "empty-idle" }),
            captureScreen: async () => scenario === "dialog" ? "Resume paused goal?\n› 1. Resume goal\n2. Leave paused\nPress enter to confirm or esc to go back" : "› " } });
        return fx.queue.read("lsrc", 4, job.id);
      }],
      then: ["only unsubmitted superseded work cancels, busy/dialog waits, submitted ambiguity is unchanged", job => {
        if (["session-change", "new-input"].includes(scenario)) expect(job.status).toBe("cancelled");
        else if (scenario === "submitted") expect(job).toMatchObject({ status: "submitted", attempts: 1 });
        else expect(job).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: NOW + 15_000 });
      }], cleanup: fx => fx.cleanup(),
    });
  }
  component("a crash after enqueue but before clearing cannot create a second handoff", {
    given: ["one failed request-file cleanup after a successful enqueue", () => {
      const fx = fixture(), clear = fx.requests.clear;
      fx.requests.clear = () => { throw new Error("cleanup failed after durable enqueue"); };
      return { ...fx, clear };
    }],
    when: ["the next fresh controller reconciles the retained request", async fx => {
      await fx.poll().catch(() => {}); fx.requests.clear = fx.clear; await fx.poll(); return fx.queue.list("lsrc", 4);
    }],
    then: ["one job, one compact, no remaining request", (jobs, fx) => {
      expect(jobs).toHaveLength(1); expect(fx.calls).toEqual(["compact"]); expect(fx.requests.read("lsrc", 4)).toBeNull();
    }], cleanup: fx => fx.cleanup(),
  });
});
