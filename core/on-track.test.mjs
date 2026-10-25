import { feature, component, expect } from "bdd-vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { validateOnTrackReceipt } from "./on-track-validation.mjs";
import { createOnTrackMonitor } from "./on-track-monitor.mjs";
import { createState } from "./state.mjs";
import { onTrackHash } from "./on-track-evidence.mjs";
import { onTrackStatistics, ON_TRACK_STATE } from "./on-track-monitor.mjs";
import { snapshotOnTrackProject } from "./on-track-projects.mjs";

function fixture({ owner = "lsrc:4", state = "closed" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-on-track-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  const quote = `| 1 | Open film | ${owner} | Film opens | ${state} | 20min |`;
  writeFileSync(join(root, "TASKS.md"), "| # | Outcome | Owner | Done when | State | Estimate |\n|---|---|---|---|---|---|\n" + quote + "\n");
  writeFileSync(join(root, "live.json"), JSON.stringify({ live: [{ path: "open", result: "PASS", at: "2026-10-25T11:00:00.000Z" }] }));
  git("add", "TASKS.md", "live.json"); git("commit", "-qm", "fixture");
  const at = Date.parse("2026-10-25T11:00:00Z"), sha = git("rev-parse", "HEAD");
  const evidence = { kind: "file", path: "TASKS.md", sha, line: 3, quote, at: new Date(at).toISOString() };
  const cycle = { id: "cutkit:1", at, tip: sha, asks: [{ id: "ask-1", ts: new Date(at - 1000).toISOString() }], previous: null };
  const project = { id: "cutkit", root, ledger: "TASKS.md", reviewer: "lsrc:3", dispatcher: "lsrc:0", livePaths: ["open"] };
  const receipt = { project: "cutkit", at: new Date(at).toISOString(), cycle: cycle.id,
    checks: ["C1", "C2", "C3", "C4", "C5"].map(id => ({ id, result: "PASS", evidence: [evidence] })), deviations: [],
    asks: [{ askId: "ask-1", row: "1", owner, estimate: "20min", outcome: "Film opens", evidence }],
    outcomeChanges: [], rows: [], live: [{ path: "open", result: "PASS", at: new Date(at).toISOString(),
      evidence: { ...evidence, path: "live.json", line: 1, quote: JSON.stringify({ live: [{ path: "open", result: "PASS", at: "2026-10-25T11:00:00.000Z" }] }) } }], resolved: [] };
  return { root, at, sha, evidence, project, cycle, receipt };
}

feature("on-track evidence and omission protection", () => {
  component("a question without a requested outcome can cite its real posted answer", {
    given: ["a frozen original question and a canonical reply", () => {
      const f = fixture(); f.cycle.c1ScopeVersion = 2; f.cycle.c1SourceErrors = [];
      f.cycle.asks[0].replies = [{ id: "actual-post", text: "The answer" }];
      f.receipt.asks = [{ askId: "ask-1", disposition: "answered", replyId: "actual-post", reason: "A question with no new requested outcome", evidence: f.evidence }];
      return f;
    }],
    when: ["the receipt links the actual reply", f => validateOnTrackReceipt(f)],
    then: ["C1 accepts the sourced disposition", r => { expect(r.errors).toEqual([]); expect(r.valid).toBe(true); }],
  });
  component("a readable missing order is FAIL rather than UNKNOWN", {
    given: ["a fully readable original source", () => {
      const f = fixture(); f.cycle.c1ScopeVersion = 2; f.cycle.c1SourceErrors = [];
      f.receipt.checks[0].result = "UNKNOWN"; f.receipt.asks = [{ askId: "ask-1", disposition: "missing", row: null, reason: "Task missing", evidence: f.evidence }];
      f.receipt.deviations = [{ check: "C1", row: "ask-1", owner: "lsrc:3", action: "Map the actual requested outcome" }]; return f;
    }],
    when: ["UNKNOWN is used to avoid the missing-task verdict", f => validateOnTrackReceipt(f)],
    then: ["the receipt is invalid", r => expect(r.errors.join(" ")).toContain("UNKNOWN requires an unreadable")],
  });
  component("a role annotation does not invent a second owner or invalidate the real owner log", {
    given: ["an actual working TASKS row with an annotated owner", () => {
      const f = fixture({ owner: "lsrc:4 (Opus V)", state: "working" });
      const text = JSON.stringify({ owner: "lsrc:4", latest: { ts: new Date(f.at).toISOString(), text: "actual owner progress" } });
      const evidence = { kind: "command", record: "owner", command: ["read-owner-log"], at: f.receipt.at, exitCode: 0, sha256: onTrackHash(text) };
      f.receipt.asks[0].owner = "lsrc:4";
      f.receipt.rows = [{ row: "1", evidence: f.evidence, ownerLog: evidence, progressAt: f.receipt.at }];
      f.commands = { owner: { ...evidence, project: f.project.id, cycle: f.cycle.id, stdout: text } };
      return f;
    }],
    when: ["the source-bound receipt is validated", f => validateOnTrackReceipt(f)],
    then: ["the single real owner and actual log qualify", r => { expect(r.errors).toEqual([]); expect(r.valid).toBe(true); }],
  });
  component("an explicitly human-owned deviation remains assignable", {
    given: ["a missing live proof with a human decision owner", fixture],
    when: ["the reviewer records the actual decision dependency", f => {
      f.receipt.checks[3].result = "UNKNOWN"; f.receipt.live = [];
      f.receipt.deviations = [{ check: "C4", row: "open", owner: "human", action: "Decide the existing blocked user outcome" }];
      return validateOnTrackReceipt(f);
    }],
    then: ["the human owner is preserved", r => { expect(r.valid).toBe(true); expect(r.deviations[0].owner).toBe("human"); }],
  });
  component("two real repeated ask identities remain required while the timer excludes itself", {
    given: ["a project and two human orders with identical words", fixture],
    when: ["the canonical ask window is frozen", f => snapshotOnTrackProject({ ...f.project, askAgents: ["lsrc"] }, f.at, {
      bindings: () => [], window: () => ({ files: ["synthetic-ledger"], asks: [
        ...["first", "second"].map(id => ({ id, source: "discord", agent: "lsrc", pane: 3, verbatim: "Open film", ts: new Date(f.at - 1000).toISOString() })),
        { id: "timer", source: "on-track", agent: "lsrc", pane: 3, verbatim: "[from amux on-track]\n\nRead C1-C5", ts: new Date(f.at - 1000).toISOString() },
      ] }),
    })],
    then: ["both human IDs and no timer input remain", r => expect(r.asks.map(a => a.id)).toEqual(["first", "second"])],
  });
  component("real source evidence can be accepted without sending a green status", {
    given: ["an actual repository and complete receipt", fixture],
    when: ["the complete receipt is checked", f => validateOnTrackReceipt(f)],
    then: ["it is valid and includes an independent sample", r => { expect(r.errors).toEqual([]); expect(r.valid).toBe(true); expect(r.sampled).toMatch(/^C[1-5]$/u); }],
  });
  component("a cited line is read from Git, not trusted from the reviewer", {
    given: ["an actual repository and receipt", fixture],
    when: ["the claimed quote is fabricated", f => { f.receipt.checks[0].evidence[0] = { ...f.evidence, quote: "invented" }; return validateOnTrackReceipt(f); }],
    then: ["the receipt is invalid", r => expect(r.valid).toBe(false)],
  });
  component("omitting a human ask cannot produce a green receipt", {
    given: ["an actual repository and receipt", fixture],
    when: ["the mapping is removed", f => { f.receipt.asks = []; return validateOnTrackReceipt(f); }],
    then: ["C1 is rejected", r => expect(r.errors.join(" ")).toContain("ask-1")],
  });
  component("old live proof cannot be refreshed by dating the receipt", {
    given: ["an actual repository and receipt", fixture],
    when: ["the live observation is stale", f => { f.receipt.live[0].at = new Date(f.at - 3600001).toISOString(); return validateOnTrackReceipt(f); }],
    then: ["C4 is rejected", r => expect(r.errors.join(" ")).toContain("C4")],
  });
  component("UNKNOWN remains an owned deviation", {
    given: ["an actual repository and receipt", fixture],
    when: ["a check reports unknown without an owner", f => { f.receipt.checks[2].result = "UNKNOWN"; return validateOnTrackReceipt(f); }],
    then: ["the unowned deviation is invalid", r => expect(r.valid).toBe(false)],
  });
  component("a changed outcome needs a real human instruction", {
    given: ["an actual repository and receipt", fixture],
    when: ["the former outcome differs", f => { f.cycle.previous = { outcomes: { 1: "Keep film" }, deviations: [] }; return validateOnTrackReceipt(f); }],
    then: ["C2 is rejected", r => expect(r.errors.join(" ")).toContain("C2")],
  });
  component("a random PASS is checked again independently", {
    given: ["an actual repository and receipt", fixture],
    when: ["the independent read disagrees", f => validateOnTrackReceipt({ ...f, sample: () => 0, recheck: () => false })],
    then: ["the entire receipt is invalid", r => expect(r.errors.join(" ")).toContain("sample")],
  });
  component("a captured command cannot be replaced by a reviewer-provided hash", {
    given: ["an actual repository and receipt", fixture],
    when: ["a command observation is invented", f => {
      f.receipt.checks[0].evidence = [{ kind: "command", record: "invented", command: ["true"], exitCode: 0, sha256: onTrackHash(""), at: f.receipt.at }];
      return validateOnTrackReceipt(f);
    }],
    then: ["the receipt is invalid", r => expect(r.valid).toBe(false)],
  });
  component("a source's stale live timestamp cannot be replaced by the reviewer", {
    given: ["an actual repository and receipt", fixture],
    when: ["the source and claimed observation times differ", f => {
      const text = JSON.stringify({ live: [{ path: "open", result: "PASS", at: new Date(f.at - 3600001).toISOString() }] });
      const evidence = { kind: "command", record: "live", command: ["read-native-receipt"], exitCode: 0, sha256: onTrackHash(text), at: f.receipt.at };
      f.receipt.live[0].evidence = evidence;
      return validateOnTrackReceipt({ ...f, commands: { live: { ...evidence, project: f.project.id, cycle: f.cycle.id, stdout: text } } });
    }],
    then: ["C4 is rejected", r => expect(r.errors.join(" ")).toContain("C4")],
  });
  component("a genuinely unknown live path is an owned deviation rather than a score", {
    given: ["an actual repository and receipt", fixture],
    when: ["the reviewer reports the missing proof explicitly", f => {
      f.receipt.checks[3].result = "UNKNOWN"; f.receipt.live = [];
      f.receipt.deviations = [{ check: "C4", row: "open", owner: "lsrc:3", action: "Read the actual live receipt" }];
      return validateOnTrackReceipt(f);
    }],
    then: ["the review is valid and the deviation is retained", r => { expect(r.valid).toBe(true); expect(r.deviations).toHaveLength(1); }],
  });
  component("a previous deviation cannot disappear behind a PASS", {
    given: ["an actual repository and receipt", fixture],
    when: ["the prior issue has no resolution or owner", f => {
      f.cycle.previous = { deviations: [{ check: "C4", row: "play", owner: "lsrc:3", action: "Read playback proof" }] };
      return validateOnTrackReceipt(f);
    }],
    then: ["C5 is rejected", r => expect(r.errors.join(" ")).toContain("C5")],
  });
  component("a reverted historical outcome change still requires a human source", {
    given: ["an actual repository and receipt", fixture],
    when: ["Git history includes an otherwise hidden intermediate change", f => {
      f.cycle.outcomeHistory = { base: f.sha, changes: [{ row: "1", sha: f.sha, at: f.at }], commits: [f.sha] };
      return validateOnTrackReceipt(f);
    }],
    then: ["C2 is rejected", r => expect(r.errors.join(" ")).toContain("C2")],
  });
});

feature("on-track durable schedule", () => {
  component("a restart cannot forget or duplicate the overdue escalation", {
    given: ["a monitor with a durable store", () => {
      const f = fixture(), state = createState(join(f.root, "state.json")); let time = f.at; const sent = [];
      const dependencies = { state, projects: () => [f.project], now: () => time,
        snapshot: () => ({ tip: f.sha, asks: f.cycle.asks }),
        send: async (target, text, key) => { sent.push({ target, text, key }); return { id: key }; } };
      return { ...f, sent, dependencies, advance: () => { time += 1200001; } };
    }],
    when: ["the deadline passes and the bridge restarts", async f => {
      await createOnTrackMonitor(f.dependencies).tick(); f.advance();
      await createOnTrackMonitor(f.dependencies).tick(); await createOnTrackMonitor(f.dependencies).tick(); return f.sent;
    }],
    then: ["one reminder and two recipient escalations exist", sent => {
      expect(sent).toHaveLength(3); expect(new Set(sent.map(s => s.key)).size).toBe(3);
    }],
  });
  component("an unknown send is never tried again after restart", {
    given: ["a durable monitor whose transport loses its response", () => {
      const f = fixture(); let calls = 0;
      const state = createState(join(f.root, "uncertain.json"));
      return { f, getCalls: () => calls, dependencies: { state, projects: () => [f.project], now: () => f.at,
        snapshot: () => ({ tip: f.sha, asks: [] }), send: async () => { calls++; throw Error("response lost"); }, log: () => {} } };
    }],
    when: ["two monitor instances inspect the same episode", async f => {
      await createOnTrackMonitor(f.dependencies).tick(); await createOnTrackMonitor(f.dependencies).tick(); return f;
    }],
    then: ["only the original attempt exists", f => expect(f.getCalls()).toBe(1)],
  });
  component("a late valid correction preserves the missed-deadline observation", {
    given: ["an overdue cycle in a durable monitor", () => {
      const f = fixture(); let at = f.at;
      const state = createState(join(f.root, "late.json")), sent = [];
      const monitor = createOnTrackMonitor({ state, projects: () => [f.project], now: () => at,
        snapshot: () => ({ tip: f.sha, asks: f.cycle.asks }), send: async target => { sent.push(target); return { id: String(sent.length) }; } });
      return { ...f, monitor, state, sent, advance: () => { at += 1200001; } };
    }],
    when: ["a valid late receipt arrives", async f => {
      await f.monitor.tick(); f.advance(); await f.monitor.tick();
      f.receipt.cycle = f.state.get(ON_TRACK_STATE).projects.cutkit.cycle.id;
      f.receipt.at = new Date(f.at + 1200001).toISOString();
      await f.monitor.submit(f.project, f.receipt, f.project.reviewer);
      return { stats: onTrackStatistics(f.state.get(ON_TRACK_STATE), f.at + 1200001), sent: f.sent };
    }],
    then: ["the violation remains visible and green adds no notification", r => { expect(r.stats[0].deviations24h).toBe(1); expect(r.sent).toHaveLength(3); }],
  });
  component("a restart after several missed hours emits one catch-up review", {
    given: ["a durable monitor with an old schedule", () => {
      const f = fixture(); let at = f.at; const sent = [];
      const state = createState(join(f.root, "missed.json"));
      return { sent, dependencies: { state, projects: () => [f.project], now: () => at,
        snapshot: () => ({ tip: f.sha, asks: [] }), send: async (target, text, key) => { sent.push(key); return { id: key }; } },
      advance: () => { at += 8 * 3600000; } };
    }],
    when: ["the bridge resumes and observes repeated heartbeats", async f => {
      await createOnTrackMonitor(f.dependencies).tick(); f.advance();
      await createOnTrackMonitor(f.dependencies).tick(); await createOnTrackMonitor(f.dependencies).tick(); return f.sent;
    }],
    then: ["there are two reviews and one escalation per recipient", sent => { expect(sent.filter(k => k.endsWith(":reminder"))).toHaveLength(2); expect(sent).toHaveLength(4); }],
  });
  component("a foreign reviewer cannot submit or send any notification", {
    given: ["a pending cycle", () => {
      const f = fixture(), state = createState(join(f.root, "actor.json")), sent = [];
      const monitor = createOnTrackMonitor({ state, projects: () => [f.project], now: () => f.at,
        snapshot: () => ({ tip: f.sha, asks: [] }), send: async target => { sent.push(target); return { id: "one" }; } });
      return { ...f, monitor, sent };
    }],
    when: ["another pane tries to submit", async f => {
      await f.monitor.tick();
      try { await f.monitor.submit(f.project, f.receipt, "lsrc:4"); return { error: "", sent: f.sent }; }
      catch (error) { return { error: error.message, sent: f.sent }; }
    }],
    then: ["it refuses before any new send", r => { expect(r.error).toContain("reviewer identity"); expect(r.sent).toHaveLength(1); }],
  });
});
