import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPauseCompact, createQuotaParkStore } from "./pause-compact.mjs";
import { createSelfCompactStore } from "../core/self-compact.mjs";

const NOW = Date.parse("2026-10-11T03:36:00Z");
const lsrc = { name: "lsrc", orchestrator: 3, leaders: [0] };

function controller(mode, { compacted = true, codexMode = "dry" } = {}) {
  let now = NOW;
  const runs = [], lines = [];
  const pause = createPauseCompact({ modes: { claude: mode, codex: codexMode }, now: () => now, state: { get: () => ({}) },
    contextMaintenance: { run: async (name, pane, options) => {
      runs.push({ pane: `${name}:${pane}`, ...options });
      return options.dry ? { ok: true, dry: true, cell: "compact-once", tokens: 710_858 } : { ok: compacted, compacted, cell: "compact-once" };
    } },
    record: line => lines.push(line),
    identityFor: () => ({ path: "/projects/lsrc-2/s1.jsonl", sessionId: "s1" }),
    backgroundFor: { claude: () => null, codex: () => null }, journalCompactFor: () => null });
  // lsrc:2's turn ended at 03:34:38, 82 s before the poll, like the night's last case.
  const poll = (facts = {}) => pause.consider({ agentConfig: lsrc, pane: 2, engine: "claude", paneDir: "/lsrc/.agents/2", status: "idle",
    inCopyMode: false, contextTokens: 710_858, lastActivityMs: NOW - 82_000, ...facts });
  return { runs, lines, poll, later: ms => { now += ms; } };
}

feature("pause compaction in the bridge poll", () => {
  component("a dry run logs one would-be compact per pause and sends nothing", {
    given: ["dry mode and lsrc:2 over budget at a pause", () => controller("dry")],
    when: ["polling three times a minute apart", async ctx => {
      const sent = [await ctx.poll()];
      ctx.later(60_000); sent.push(await ctx.poll());
      ctx.later(60_000); sent.push(await ctx.poll());
      return sent;
    }],
    then: ["one dry admission, one would-compact line, then the spacing hold", (sent, ctx) => {
      expect(sent).toEqual([false, false, false]);
      expect(ctx.runs).toEqual([{ pane: "lsrc:2", pauseTokens: 400_000, dry: true }]);
      expect(ctx.lines.map(line => `${line.outcome}:${line.cell}`)).toEqual(["would-compact:pause", "held:spacing"]);
      expect(ctx.lines[0]).toMatchObject({ pane: "lsrc:2", mode: "dry", tokens: 710_858, limit: 400_000, leader: false, quietSec: 82 });
    }],
  });
  component("a leader under 700k is left alone and nothing is logged", {
    given: ["dry mode", () => controller("dry")],
    when: ["polling lsrc:0 at 517k after its turn", ctx => ctx.poll({ pane: 0, contextTokens: 517_854 })],
    then: ["no admission, no line", (sent, ctx) => { expect(sent).toBe(false); expect(ctx.runs).toEqual([]); expect(ctx.lines).toEqual([]); }],
  });
  component("an idle builder under budget is never touched", {
    given: ["live mode", () => controller("on")],
    when: ["polling lsrc:2 at 300k, idle an hour", ctx => ctx.poll({ contextTokens: 300_000, lastActivityMs: NOW - 3_600_000 })],
    then: ["no admission", (sent, ctx) => { expect(sent).toBe(false); expect(ctx.runs).toEqual([]); }],
  });
  component("live mode compacts and tells the 50-minute rule it did", {
    given: ["live mode", () => controller("on")],
    when: ["polling lsrc:2 at the pause", ctx => ctx.poll()],
    then: ["one compact with the builder budget, logged", (sent, ctx) => {
      expect(sent).toBe(true);
      expect(ctx.runs).toEqual([{ pane: "lsrc:2", pauseTokens: 400_000, dry: false }]);
      expect(ctx.lines.map(line => line.outcome)).toEqual(["compacted"]);
    }],
  });
  component("Codex stays dry while Claude is live", {
    given: ["Claude live, Codex at its default", () => controller("on")],
    when: ["polling Codex lsrc:4 over budget at a pause", ctx => ctx.poll({ pane: 4, engine: "codex" })],
    then: ["only a dry admission, logged as dry", (sent, ctx) => {
      expect(sent).toBe(false);
      expect(ctx.runs).toEqual([{ pane: "lsrc:4", pauseTokens: 400_000, dry: true }]);
      expect(ctx.lines[0]).toMatchObject({ outcome: "would-compact", mode: "dry" });
    }],
  });
  component("a quiet Codex pane is logged at 25 minutes against the 150k Codex floor", {
    given: ["dry mode", () => controller("dry")],
    when: ["polling Codex lsrc:4 at 200k and at 120k, 26 minutes after its turn", async ctx => {
      const quiet = { pane: 4, engine: "codex", lastActivityMs: NOW - 26 * 60_000 };
      return [await ctx.poll({ ...quiet, contextTokens: 120_000 }), await ctx.poll({ ...quiet, contextTokens: 200_000 })];
    }],
    then: ["120k is left alone, 200k gets a dry admission against 150k", (sent, ctx) => {
      expect(sent).toEqual([false, false]);
      expect(ctx.runs).toEqual([{ pane: "lsrc:4", pauseTokens: 150_000, dry: true }]);
      expect(ctx.lines[0]).toMatchObject({ outcome: "would-compact", cell: "codex-idle", limit: 150_000, mode: "dry" });
    }],
  });
  component("off mode does nothing", {
    given: ["off mode", () => controller("off")],
    when: ["polling lsrc:2 at the pause", ctx => ctx.poll()],
    then: ["no admission, no line", (sent, ctx) => { expect(sent).toBe(false); expect(ctx.runs).toEqual([]); expect(ctx.lines).toEqual([]); }],
  });
});

// lsrc:0, a leader at 150k: far under its 700k pause limit, so only its own request compacts it.
function selfController({ background = null } = {}) {
  let now = NOW;
  const dir = mkdtempSync(join(tmpdir(), "amux-self-compact-"));
  const requests = createSelfCompactStore({ dir, now: () => now });
  const runs = [], lines = [], notices = [];
  const pause = createPauseCompact({ modes: { claude: "on", codex: "on" }, now: () => now, state: { get: () => ({}) },
    contextMaintenance: { run: async (name, pane, options) => { runs.push({ pane: `${name}:${pane}`, ...options }); return { ok: true, compacted: true }; } },
    record: line => lines.push(line), identityFor: () => ({ path: "/projects/lsrc-0/s1.jsonl", sessionId: "s1" }),
    backgroundFor: { claude: () => background, codex: () => background }, journalCompactFor: () => null,
    selfRequests: requests, notify: async (agent, pane, text) => notices.push(`${agent}:${pane} ${text}`) });
  const poll = (facts = {}) => pause.consider({ agentConfig: lsrc, pane: 0, engine: "claude", paneDir: "/lsrc/.agents/0",
    status: "idle", inCopyMode: false, contextTokens: 150_000, lastActivityMs: now, ...facts });
  return { requests, runs, lines, notices, poll, later: ms => { now += ms; }, at: () => now,
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

feature("a pane's own request to be compacted", () => {
  component("a request made mid-turn compacts when the turn ends, not during it", {
    given: ["lsrc:0 at 150k asks at a stage boundary while its turn runs", () => {
      const ctx = selfController();
      ctx.requests.request({ agent: "lsrc", pane: 0, tokens: 150_000, focus: "behåll G4-siffrorna" });
      return ctx;
    }],
    when: ["polling during the turn, then a minute after it ends", async ctx => {
      const during = await ctx.poll({ status: "working", lastActivityMs: ctx.at() });
      const turnEnded = ctx.at();
      ctx.later(61_000);
      const after = await ctx.poll({ lastActivityMs: turnEnded });
      return { during, after };
    }],
    then: ["nothing during the turn, one focused compact after it, the request ended and mirrored", ({ during, after }, ctx) => {
      try {
        expect(during).toBe(false);
        expect(after).toBe(true);
        expect(ctx.runs).toEqual([{ pane: "lsrc:0", pauseTokens: 80_000, dry: false, focus: "behåll G4-siffrorna" }]);
        expect(ctx.requests.list()).toEqual([]);
        expect(ctx.lines.at(-1)).toMatchObject({ outcome: "compacted", cell: "self-request" });
        expect(ctx.notices).toEqual(["lsrc:0 Self-compact **lsrc:0** at the end of its turn (150000 tokens), focus: behåll G4-siffrorna."]);
      } finally { ctx.cleanup(); }
    }],
  });
  component("a request waits while a subagent writes", {
    given: ["lsrc:0 asked; its subagent wrote 20 s ago", () => {
      const ctx = selfController({ background: "subagent wrote 20 s ago" });
      ctx.requests.request({ agent: "lsrc", pane: 0, tokens: 150_000 });
      return ctx;
    }],
    when: ["polling a minute after the turn ended", async ctx => {
      const turnEnded = ctx.at();
      ctx.later(61_000);
      return ctx.poll({ lastActivityMs: turnEnded });
    }],
    then: ["held, no compact, the request kept", (sent, ctx) => {
      try {
        expect(sent).toBe(false);
        expect(ctx.runs).toEqual([]);
        expect(ctx.lines.at(-1)).toMatchObject({ outcome: "held", cell: "background-active" });
        expect(ctx.requests.list()).toHaveLength(1);
      } finally { ctx.cleanup(); }
    }],
  });
});

// lsrc:0 2026-10-19: the size rule waits for a pause and 13 attempts were refused as busy,
// so long turns reached 943k against a 400k budget.
feature("a working pane far past its budget", () => {
  const working = (jobs = []) => {
    const enqueued = [];
    const pause = createPauseCompact({ modes: { claude: "on", codex: "on" }, now: () => NOW, state: { get: () => ({}) },
      contextMaintenance: { run: async () => { throw new Error("compacted mid-turn"); } }, record: () => {},
      identityFor: () => ({ path: "/projects/lsrc-2/s1.jsonl", sessionId: "s1" }),
      backgroundFor: { claude: () => null, codex: () => null }, journalCompactFor: () => null,
      deliveryBroker: { queue: { list: () => [...jobs, ...enqueued] }, enqueue: job => { enqueued.push({ ...job, status: "pending" }); return job; } } });
    const poll = tokens => pause.consider({ agentConfig: lsrc, pane: 2, engine: "claude", paneDir: "/lsrc/.agents/2",
      status: "working", inCopyMode: false, contextTokens: tokens, lastActivityMs: NOW });
    return { enqueued, poll };
  };

  component("is asked once to bank its work and compact itself, and nothing compacts it mid-turn", {
    given: ["builder lsrc:2 working at 600k, 1.5 times its 400k budget", () => working()],
    when: ["polling three times while it works on", async ctx => [await ctx.poll(600_000), await ctx.poll(640_000), await ctx.poll(700_000)]],
    then: ["one notice waits in its queue, and no compact ran", (sent, ctx) => {
      expect(sent).toEqual([false, false, false]);
      expect(ctx.enqueued).toHaveLength(1);
      expect(ctx.enqueued[0]).toMatchObject({ agentName: "lsrc", pane: 2, source: "pause-compact" });
      expect(ctx.enqueued[0].text).toContain("amux compact --self");
    }],
  });
  component("waits while a delivery to it is still on its way", {
    given: ["a brief still pending to lsrc:2", () => working([{ id: "brief", idempotencyKey: "brief", status: "pending" }])],
    when: ["polling at 620k", ctx => ctx.poll(620_000)],
    then: ["no notice yet", (sent, ctx) => expect(ctx.enqueued).toEqual([])],
  });
});

// lsrc:0 2026-10-19: a pane its account will stop for longer than its prompt cache lives
// compacts first, so the restart after the reset is not a cold read of a huge context.
feature("a pane whose account is about to stop it", () => {
  const nearLimit = (resetInMs, { background = null } = {}) => {
    let now = NOW, supersede = false;
    const dir = mkdtempSync(join(tmpdir(), "amux-quota-park-"));
    const session = join(dir, "s1.jsonl");
    writeFileSync(session, "{}\n");
    const requests = createSelfCompactStore({ dir, now: () => now });
    const parks = createQuotaParkStore({ dir: join(dir, "parks") });
    const runs = [], lines = [];
    const pause = createPauseCompact({ modes: { claude: "on", codex: "on" }, now: () => now, state: { get: () => ({}) },
      contextMaintenance: { run: async (name, pane, options) => { runs.push({ pane: `${name}:${pane}`, ...options }); return { ok: true, compacted: true }; },
        selfRequestSuperseded: () => supersede },
      record: line => lines.push(line), identityFor: () => ({ path: session, sessionId: "s1" }),
      backgroundFor: { claude: () => background, codex: () => null }, journalCompactFor: () => null, selfRequests: requests,
      parkFor: async () => ({ account: { name: "Claude S", key: "claude:1" },
        windows: [{ kind: "session", usedPercent: 97, resetsAt: new Date(NOW + resetInMs).toISOString() }] }),
      parkStore: parks, limitReceiptFor: () => null });
    const poll = facts => pause.consider({ agentConfig: lsrc, pane: 2, engine: "claude", paneDir: "/lsrc/.agents/2",
      status: "idle", inCopyMode: false, contextTokens: 150_000, ...facts });
    return { runs, lines, requests, parks, poll, turnEndsThenWait: async () => { const ended = now; now += 61_000; return poll({ lastActivityMs: ended }); },
      working: () => { now += 30_000; return poll({ status: "working", lastActivityMs: now }); },
      newInput: async () => { supersede = true; now += 30_000; const sent = await poll({ status: "working", lastActivityMs: now }); supersede = false; return sent; },
      cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };

  component("with 3 % left and the reset 4 h away it is compacted at its turn end", {
    given: ["builder lsrc:2 at 150k, its account at 97 % until 4 h from now", () => nearLimit(4 * 3_600_000)],
    when: ["polling a minute after its turn ended", ctx => ctx.turnEndsThenWait()],
    then: ["one compact through the self-request path", (sent, ctx) => {
      try {
        expect(sent).toBe(true);
        expect(ctx.runs).toEqual([expect.objectContaining({ pane: "lsrc:2", pauseTokens: 80_000, dry: false })]);
        expect(ctx.lines.map(line => `${line.outcome}:${line.cell}`)).toEqual(["parked:quota-park", "compacted:self-request"]);
        // Quota recovery resumes it from this record once Claude S has room (lsrc:0, 2026-10-19).
        expect(ctx.parks.list()).toEqual([expect.objectContaining({ agentName: "lsrc", pane: 2, state: "parked",
          account: { name: "Claude S", key: "claude:1" }, window: "session", resetAt: NOW + 4 * 3_600_000 })]);
      } finally { ctx.cleanup(); }
    }],
  });
  // 2026-10-20 10:19Z: api:0, claw:1 and claw:2 were parked, held by a job still writing, and stopped uncompacted.
  component("a pane whose subagent or job still works is compacted at its turn end all the same", {
    given: ["the same pane while a job wrote 38 s ago, like api:0", () => nearLimit(4 * 3_600_000,
      { background: "a subagent or background job wrote 38s ago" })],
    when: ["polling a minute after its turn ended", ctx => ctx.turnEndsThenWait()],
    then: ["parked and compacted", (sent, ctx) => {
      try {
        expect(sent).toBe(true);
        expect(ctx.lines.map(line => `${line.outcome}:${line.cell}`)).toEqual(["parked:quota-park", "compacted:self-request"]);
      } finally { ctx.cleanup(); }
    }],
  });
  // claw:1 at 10:24:58Z and api:0 at 10:31:39Z: new input dropped the park, and nothing parked them again for that stop.
  component("a park that new input superseded parks the pane again at its next turn end", {
    given: ["the same pane, parked while its turn runs", () => nearLimit(4 * 3_600_000)],
    when: ["new input arrives, then the turn ends", async ctx => {
      await ctx.working();
      await ctx.newInput();
      return ctx.turnEndsThenWait();
    }],
    then: ["parked, dropped, parked again and compacted", (sent, ctx) => {
      try {
        expect(sent).toBe(true);
        expect(ctx.lines.map(line => `${line.outcome}:${line.cell}`))
          .toEqual(["parked:quota-park", "dropped:self-request", "parked:quota-park", "compacted:self-request"]);
      } finally { ctx.cleanup(); }
    }],
  });
  component("with the reset 15 min away it is left alone, since its cache outlives the stop", {
    given: ["the same pane, the reset 15 min away", () => nearLimit(15 * 60_000)],
    when: ["polling a minute after its turn ended", ctx => ctx.turnEndsThenWait()],
    then: ["no compact and no request", (sent, ctx) => {
      try {
        expect(sent).toBe(false);
        expect(ctx.runs).toEqual([]);
        expect(ctx.requests.list()).toEqual([]);
        expect(ctx.parks.list()).toEqual([]);
      } finally { ctx.cleanup(); }
    }],
  });
});
