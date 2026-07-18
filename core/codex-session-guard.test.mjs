// Contract for pane-scoped codex session selection (skydive model-override
// incident). Proves the guard resumes ONLY a pane's own, provenance-matched,
// unheld session and blocks everything else — never the global latest and
// never a silent fresh fallback.

import { feature, unit, expect } from "bdd-vitest";
import {
  allowsFreshCodexBootstrap, decideCodexStart, liveRolloutWriters, modelOverrideAudit,
} from "./codex-session-guard.mjs";

const rolloutPathFor = (id) => (id ? `/home/x/.codex/sessions/rollout-${id}.jsonl` : null);
const noWriters = () => [];

feature("codex session guard (never resume --last)", () => {
  unit("the global-latest session of ANOTHER pane is refused even when dead/unheld", {
    // scenario 1: `--last` would grab this; provenance must reject it.
    when: ["a pane whose only candidate is another pane's session", () =>
      decideCodexStart({
        pane: "skydive:7",
        persisted: { sessionId: "aaaa", pane: "skydive:1.16" },
        rolloutPathFor, writersFor: noWriters,
      })],
    then: ["it blocks foreign provenance, not resume or fresh", (decision) => {
      expect(decision.action).toBe("blocked");
      expect(decision.reason).toBe("foreign-provenance");
      expect(decision.sessionId).toBe("aaaa");
    }],
  });

  unit("a pane's own, unheld session resumes exactly", {
    // scenario 2
    when: ["the persisted session belongs to the pane and no live writer holds it", () =>
      decideCodexStart({
        pane: "skydive:7",
        persisted: { sessionId: "bbbb", pane: "skydive:7" },
        rolloutPathFor, writersFor: noWriters,
      })],
    then: ["it resumes that exact id", (decision) => {
      expect(decision).toMatchObject({ action: "resume", sessionId: "bbbb", reason: "own-unheld-session" });
    }],
  });

  unit("a pane's own session still held by a live writer blocks (defense-in-depth)", {
    // scenario 3
    when: ["the own session's rollout is held by another live pid", () =>
      decideCodexStart({
        pane: "skydive:7",
        persisted: { sessionId: "cccc", pane: "skydive:7" },
        rolloutPathFor,
        writersFor: () => [144186],
      })],
    then: ["it refuses to become a second writer and names the holder", (decision) => {
      expect(decision.action).toBe("blocked");
      expect(decision.reason).toBe("rollout-held-by-live-writer");
      expect(decision.heldBy).toEqual([144186]);
    }],
  });

  unit("no persisted mapping blocks by default", {
    // scenario 4
    when: ["the pane recorded no session of its own", () =>
      decideCodexStart({ pane: "skydive:7", persisted: null, rolloutPathFor, writersFor: noWriters })],
    then: ["it refuses a silent fresh session", (decision) => {
      expect(decision).toMatchObject({ action: "blocked", reason: "no-persisted-session", sessionId: null });
    }],
  });

  unit("an explicitly new pane/profile may bootstrap exactly once", {
    when: ["the caller proves this is a first bootstrap", () => decideCodexStart({
      pane: "skydive:7", persisted: null, rolloutPathFor, writersFor: noWriters,
      allowFreshBootstrap: true,
    })],
    then: ["fresh is explicit and auditable", (decision) => {
      expect(decision).toMatchObject({ action: "fresh", reason: "explicit-first-bootstrap" });
    }],
  });

  unit("a fenced pre-rollout bootstrap may retry only for the same pane/profile", {
    given: ["durable receipts from before Codex receives its first prompt", () => ({
      ownWaiting: {
        pane: "skybar:6@1", profileId: "1", sessionId: null,
        status: "awaiting-first-rollout", startedAt: 1_784_400_511_340,
      },
      legacyInterrupted: {
        pane: "skybar:6@1", profileId: "1", sessionId: null,
        status: "bootstrapping", startedAt: 1_784_400_511_340,
      },
      foreignInterrupted: {
        pane: "ai:3@1", profileId: "1", sessionId: null,
        status: "bootstrapping", startedAt: 1_784_400_511_340,
      },
      readyWithoutIdentity: {
        pane: "skybar:6@1", profileId: "1", sessionId: null, status: "ready",
      },
    })],
    when: ["fresh-launch authority is derived from each receipt", (receipts) => ({
      first: allowsFreshCodexBootstrap("skybar:6@1", null),
      ownWaiting: allowsFreshCodexBootstrap("skybar:6@1", receipts.ownWaiting),
      legacyInterrupted: allowsFreshCodexBootstrap("skybar:6@1", receipts.legacyInterrupted),
      foreignRetry: allowsFreshCodexBootstrap("skybar:6@1", receipts.foreignInterrupted),
      malformedReady: allowsFreshCodexBootstrap("skybar:6@1", receipts.readyWithoutIdentity),
    })],
    then: ["only first launch and exact pre-rollout receipts are authorized", (authority) => {
      expect(authority).toEqual({
        first: true,
        ownWaiting: true,
        legacyInterrupted: true,
        foreignRetry: false,
        malformedReady: false,
      });
    }],
  });

  unit("a persisted own session whose rollout no longer exists blocks", {
    when: ["the rollout file for the recorded id is gone", () =>
      decideCodexStart({
        pane: "skydive:7",
        persisted: { sessionId: "dddd", pane: "skydive:7" },
        rolloutPathFor: () => null,
        writersFor: noWriters,
      })],
    then: ["it reports continuity loss rather than creating a replacement", (decision) => {
      expect(decision).toMatchObject({ action: "blocked", reason: "session-rollout-missing" });
    }],
  });

  unit("liveRolloutWriters counts writable rollout fds, not concurrent read-only scans", {
    given: ["a fake /proc with read-only, writable, unknown and unrelated rollout fds", () => {
      const target = "/rollout/target.jsonl";
      const fds = {
        "100": { "3": target, flags: "flags:\t0100000\n" },
        "200": { "5": "/rollout/other.jsonl" },
        "300": { "7": target, flags: "flags:\t0100002\n" },
        "400": { "8": target },
        "999": { "1": target }, // self, must be excluded
      };
      return {
        target,
        opts: {
          procRoot: "/proc", selfPid: 999,
          listDir: (p) => p === "/proc" ? Object.keys(fds)
            : Object.keys(fds[p.split("/")[2]] || {}),
          readLink: (p) => {
            const [, , pid, , fd] = p.split("/");
            return fds[pid][fd];
          },
          readFile: (p) => {
            const [, , pid] = p.split("/");
            if (!fds[pid].flags) throw new Error("fdinfo unreadable");
            return fds[pid].flags;
          },
        },
      };
    }],
    when: ["scanning for writers", ({ target, opts }) => liveRolloutWriters(target, opts)],
    then: ["readers are ignored while writable and unprovable holders fail closed", (writers) => {
      expect(writers.sort()).toEqual([300, 400]);
    }],
  });

  unit("a model-override audit carries actor/source provenance and the chosen session", {
    when: ["recording an override", () => modelOverrideAudit({
      pane: "skydive:7", fromModel: "gpt-5.6-sol", toModel: "gpt-5.6-sol",
      actor: "skydive:2", source: "bridge-model-command",
      sessionAction: "fresh", sessionId: null, at: 1_784_140_000_000,
    })],
    then: ["the record is complete and immutable", (record) => {
      expect(record).toMatchObject({
        kind: "model-override", pane: "skydive:7", actor: "skydive:2",
        source: "bridge-model-command", sessionAction: "fresh",
      });
      expect(Object.isFrozen(record)).toBe(true);
    }],
  });

  unit("an audit without actor or timestamp is rejected loudly", {
    when: ["building incomplete audit records", () => [
      (() => { try { modelOverrideAudit({ pane: "p", source: "s", at: 1 }); return null; } catch (e) { return e.message; } })(),
      (() => { try { modelOverrideAudit({ pane: "p", actor: "a", source: "s" }); return null; } catch (e) { return e.message; } })(),
    ]],
    then: ["each names the missing field instead of silently defaulting", ([noActor, noTs]) => {
      expect(noActor).toMatch(/requires actor/);
      expect(noTs).toMatch(/numeric timestamp/);
    }],
  });
});
