// Contract for pane-scoped codex session selection (skydive model-override
// incident). Proves the guard resumes ONLY a pane's own, provenance-matched,
// unheld session and falls fresh for everything else — never the global latest.

import { feature, unit, expect } from "bdd-vitest";
import {
  decideCodexStart, liveRolloutWriters, modelOverrideAudit,
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
    then: ["it starts fresh on foreign provenance, not resume", (decision) => {
      expect(decision.action).toBe("fresh");
      expect(decision.reason).toBe("foreign-provenance");
      expect(decision.sessionId).toBeNull();
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

  unit("a pane's own session still held by a live writer falls fresh (defense-in-depth)", {
    // scenario 3
    when: ["the own session's rollout is held by another live pid", () =>
      decideCodexStart({
        pane: "skydive:7",
        persisted: { sessionId: "cccc", pane: "skydive:7" },
        rolloutPathFor,
        writersFor: () => [144186],
      })],
    then: ["it refuses to become a second writer and names the holder", (decision) => {
      expect(decision.action).toBe("fresh");
      expect(decision.reason).toBe("rollout-held-by-live-writer");
      expect(decision.heldBy).toEqual([144186]);
    }],
  });

  unit("no persisted mapping falls fresh", {
    // scenario 4
    when: ["the pane recorded no session of its own", () =>
      decideCodexStart({ pane: "skydive:7", persisted: null, rolloutPathFor, writersFor: noWriters })],
    then: ["it starts fresh, never guessing a session", (decision) => {
      expect(decision).toMatchObject({ action: "fresh", reason: "no-persisted-session", sessionId: null });
    }],
  });

  unit("a persisted own session whose rollout no longer exists falls fresh", {
    when: ["the rollout file for the recorded id is gone", () =>
      decideCodexStart({
        pane: "skydive:7",
        persisted: { sessionId: "dddd", pane: "skydive:7" },
        rolloutPathFor: () => null,
        writersFor: noWriters,
      })],
    then: ["it starts fresh rather than resuming a missing rollout", (decision) => {
      expect(decision).toMatchObject({ action: "fresh", reason: "session-rollout-missing" });
    }],
  });

  unit("liveRolloutWriters finds only the pids holding the exact rollout path, excluding self", {
    given: ["a fake /proc where two pids hold the target and one holds another", () => {
      const target = "/rollout/target.jsonl";
      const fds = {
        "100": { "3": target },
        "200": { "5": "/rollout/other.jsonl" },
        "300": { "7": target },
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
        },
      };
    }],
    when: ["scanning for writers", ({ target, opts }) => liveRolloutWriters(target, opts)],
    then: ["only the real, non-self holders are returned", (writers) => {
      expect(writers.sort()).toEqual([100, 300]);
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
