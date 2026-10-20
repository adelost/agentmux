import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPauseCompact, createQuotaParkStore } from "./pause-compact.mjs";
import { createSelfCompactStore } from "../core/self-compact.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { createDeliveryBroker } from "../core/delivery-broker.mjs";

const NOW = Date.parse("2026-10-11T03:36:00Z");
const lsrc = { name: "lsrc", orchestrator: 3, leaders: [0] };

function windDownFixture({ mode = "on", short = false, engine = "claude" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-wind-down-poll-"));
  let now = Date.parse("2026-10-20T10:07:10Z"), status = "working", idleFor = 61_000;
  const requests = createSelfCompactStore({ dir: join(root, "requests"), now: () => now });
  const queue = createDeliveryQueue({ rootDir: join(root, "queue"), now: () => now });
  const broker = createDeliveryBroker({ agent: {}, queue, now: () => now, log: () => {} });
  const lines = [], runs = [];
  const facts = { account: { name: "Claude S", key: "claude:1", provider: engine }, observedAt: Date.parse("2026-10-20T10:03:32Z"),
    windows: [{ kind: "session", usedPercent: 94, resetsAt: "2026-10-20T11:10:00Z" }], accounts: [] };
  if (short) {
    now = Date.parse("2026-10-20T15:17:00Z");
    facts.observedAt = now;
    facts.windows = [{ kind: "session", usedPercent: 95.1, resetsAt: "2026-10-20T16:10:00Z" }];
  }
  const options = { modes: { claude: "off" }, windDownMode: mode, now: () => now, state: { get: () => ({}) },
    contextMaintenance: { run: async () => { runs.push("compact"); return { ok: true, compacted: true }; } },
    record: line => lines.push(line), deliveryBroker: broker, selfRequests: requests, parkFor: async () => facts,
    limitReceiptFor: () => null, identityFor: () => ({ path: join(root, "session.jsonl"), sessionId: "s1" }),
    journalCompactFor: () => null, backgroundFor: { claude: () => null, codex: () => null } };
  let pause = createPauseCompact(options);
  return { queue, requests, lines, runs, facts, options,
    advance: ms => { now += ms; }, idle: (quietMs = 61_000) => { status = "idle"; idleFor = quietMs; },
    restart: () => { pause = createPauseCompact(options); },
    poll: () => pause.consider({ agentConfig: lsrc, pane: 2, engine, paneDir: root,
      contextTokens: 150_000, lastActivityMs: now - (status === "idle" ? idleFor : 0), status, inCopyMode: false }),
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function readyToMove(ctx) {
  const moves = [];
  ctx.facts.accounts = [{ ok: true, provider: "claude", name: "Claude A", profile: { key: "claude:2", id: "2" },
    observation: { observedAt: "2026-10-20T10:07:09Z" }, limits: [
      { kind: "weekly_all", usedPercent: 40, resetsAt: "2026-10-23T11:10:00Z" },
      { kind: "session", usedPercent: 10, resetsAt: "2026-10-20T11:10:00Z" }] }];
  ctx.options.compactReceiptFor = () => ({ status: "VERIFIED", sessionId: "s1", finishedAt: Date.parse("2026-10-20T10:07:00Z") });
  ctx.options.moveAfterWindDown = async input => { moves.push(input); return { moved: true }; };
  ctx.restart(); ctx.idle();
  return moves;
}

feature("quota wind-down in the pause poll (component)", () => {
  component("dry mode logs a verified would-move without switching", {
    given: ["an idle verified session with fresh target room in dry mode", () => {
      const ctx = windDownFixture({ mode: "dry" }); return { ...ctx, moves: readyToMove(ctx) };
    }],
    when: ["polling twice", async ctx => { await ctx.poll(); await ctx.poll(); }],
    then: ["one dry move and no side effects", (_result, ctx) => {
      try {
        expect(ctx.lines.map(line => line.outcome)).toEqual(["would-move"]);
        expect(ctx.moves).toEqual([]); expect(ctx.requests.list()).toEqual([]); expect(ctx.queue.list("lsrc", 2)).toEqual([]);
      } finally { ctx.cleanup(); }
    }],
  });
  component("a second wind-down episode within 30 minutes of a move is logged", {
    given: ["a moved pane that soon reaches another stopping window", async () => {
      const ctx = windDownFixture(); readyToMove(ctx); await ctx.poll();
      ctx.advance(60_000); ctx.facts.observedAt = Date.parse("2026-10-20T10:08:10Z");
      ctx.facts.windows = [{ kind: "session", usedPercent: 96, resetsAt: "2026-10-20T11:11:00Z" }];
      return ctx;
    }],
    when: ["polling the new episode twice", async ctx => { await ctx.poll(); await ctx.poll(); }],
    then: ["the rapid second stop is reported once", (_result, ctx) => {
      try { expect(ctx.lines.filter(line => line.outcome === "wind-down-soon-after-move")).toHaveLength(1); }
      finally { ctx.cleanup(); }
    }],
  });
  component("a spent Codex window files no wind-down work", {
    given: ["a Codex pane still working after its session is spent", () => {
      const ctx = windDownFixture({ engine: "codex" });
      ctx.facts.windows[0].usedPercent = 100;
      return ctx;
    }],
    when: ["the wind-down poll runs", ctx => ctx.poll()],
    then: ["no notice, request or compact can spend paid credits", (_result, ctx) => {
      try {
        expect(ctx.queue.list("lsrc", 2)).toEqual([]);
        expect(ctx.requests.list()).toEqual([]);
        expect(ctx.runs).toEqual([]);
      } finally { ctx.cleanup(); }
    }],
  });
  component("a wind-down compact starts at the turn end without an extra settling minute", {
    given: ["a pane whose turn just ended", () => { const ctx = windDownFixture(); ctx.idle(0); return ctx; }],
    when: ["polling at that boundary", ctx => ctx.poll()],
    then: ["the compact starts now", (_result, ctx) => {
      try { expect(ctx.runs).toEqual(["compact"]); } finally { ctx.cleanup(); }
    }],
  });
  component("one notice and one nudge per episode, also across a restart", {
    given: ["a working pane at 5 % and its real durable broker", () => windDownFixture()],
    when: ["polling repeatedly and restarting before and after 3 %", async ctx => {
      await ctx.poll(); await ctx.poll(); ctx.restart(); await ctx.poll();
      ctx.advance(300_000); await ctx.poll(); ctx.restart(); await ctx.poll();
      return ctx.queue.list("lsrc", 2);
    }],
    then: ["two ordinary FIFO notices, each with its own durable key", (jobs, ctx) => {
      try {
        expect(jobs.map(job => job.text.split("]")[0])).toEqual(["[AMUX QUOTA WIND-DOWN · 5 %", "[AMUX QUOTA WIND-DOWN · 3 %"]);
        expect(jobs.map(job => job.idempotencyKey)).toEqual([expect.stringMatching(/^quota-wind-down:5:lsrc:2:/u), expect.stringMatching(/^quota-wind-down:3:lsrc:2:/u)]);
      } finally { ctx.cleanup(); }
    }],
  });
  component("a working pane requests a compact that runs only after its turn ends", {
    given: ["UC-1 with pause-size compaction off", () => windDownFixture()],
    when: ["polling while working, then at a clean turn end", async ctx => {
      await ctx.poll();
      expect(ctx.requests.read("lsrc", 2)?.origin).toBe("quota-wind-down");
      expect(ctx.runs).toEqual([]);
      ctx.idle(); await ctx.poll();
      return ctx.runs;
    }],
    then: ["one compact through context maintenance", (runs, ctx) => {
      try { expect(runs).toEqual(["compact"]); } finally { ctx.cleanup(); }
    }],
  });
  component("an idle pane compacts without starting a notice turn", {
    given: ["UC-2 idle at 5 %", () => { const ctx = windDownFixture(); ctx.idle(); return ctx; }],
    when: ["polling", ctx => ctx.poll()],
    then: ["a compact and no notice", (_result, ctx) => {
      try { expect(ctx.runs).toEqual(["compact"]); expect(ctx.queue.list("lsrc", 2)).toEqual([]); } finally { ctx.cleanup(); }
    }],
  });
  component("a short stop notices but files no compact request", {
    given: ["UC-5 with no spare room", () => windDownFixture({ short: true })],
    when: ["polling", ctx => ctx.poll()],
    then: ["notice only", (_result, ctx) => {
      try { expect(ctx.queue.list("lsrc", 2)).toHaveLength(1); expect(ctx.requests.list()).toEqual([]); expect(ctx.runs).toEqual([]); } finally { ctx.cleanup(); }
    }],
  });
  component("dry mode logs would-notice and would-nudge without writes", {
    given: ["dry wind-down", () => windDownFixture({ mode: "dry" })],
    when: ["polling at 5 and 3 %", async ctx => { await ctx.poll(); ctx.advance(300_000); await ctx.poll(); }],
    then: ["only dry outcomes", (_result, ctx) => {
      try {
        expect(ctx.lines.map(line => line.outcome)).toEqual(["would-notice", "would-nudge"]);
        expect(ctx.queue.list("lsrc", 2)).toEqual([]); expect(ctx.requests.list()).toEqual([]); expect(ctx.runs).toEqual([]);
      } finally { ctx.cleanup(); }
    }],
  });
  component("off mode leaves the pane alone", {
    given: ["wind-down off", () => windDownFixture({ mode: "off" })],
    when: ["polling", ctx => ctx.poll()],
    then: ["no action", (_result, ctx) => {
      try { expect(ctx.queue.list("lsrc", 2)).toEqual([]); expect(ctx.requests.list()).toEqual([]); expect(ctx.lines).toEqual([]); } finally { ctx.cleanup(); }
    }],
  });
});

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

// lsrc:0 2026-10-20 ~18:0xZ: two Codex panes compacted on paid credits after Codex A's 5 h window filled at about 17:35Z.
feature("a Codex pane whose account has spent a window", () => {
  const spent = ({ creditsAllowed = false } = {}) => {
    const runs = [], lines = [];
    const pause = createPauseCompact({ modes: { claude: "on", codex: "on" }, now: () => NOW, state: { get: () => ({}) },
      contextMaintenance: { run: async (name, pane, options) => { runs.push({ pane: `${name}:${pane}`, ...options }); return { ok: true, compacted: true }; } },
      record: line => lines.push(line), identityFor: () => ({ path: "/projects/lsrc-4/s1.jsonl", sessionId: "s1" }),
      backgroundFor: { claude: () => null, codex: () => null }, journalCompactFor: () => null, creditsAllowed,
      parkFor: async () => ({ account: { name: "Codex A", key: "codex:1", provider: "codex" },
        windows: [{ kind: "session", usedPercent: 100, resetsAt: new Date(NOW + 4 * 3_600_000).toISOString() },
          { kind: "week", usedPercent: 48, resetsAt: new Date(NOW + 6 * 86_400_000).toISOString() }] }) });
    const poll = () => pause.consider({ agentConfig: lsrc, pane: 4, engine: "codex", paneDir: "/lsrc/.agents/4", status: "idle",
      inCopyMode: false, contextTokens: 200_000, lastActivityMs: NOW - 26 * 60_000 });
    return { runs, lines, poll };
  };

  component("is not compacted on paid credits; it waits for the reset", {
    given: ["quiet Codex lsrc:4 at 200k while Codex A's 5 h window reads 100 %", () => spent()],
    when: ["polling 26 minutes after its turn", ctx => ctx.poll()],
    then: ["nothing runs and the hold is logged", (sent, ctx) => {
      expect(sent).toBe(false);
      expect(ctx.runs).toEqual([]);
      expect(ctx.lines).toEqual([expect.objectContaining({ outcome: "held", cell: "credit-hold" })]);
    }],
  });

  component("is compacted as before when credits are allowed", {
    given: ["the same pane with AMUX_CODEX_CREDITS=allow", () => spent({ creditsAllowed: true })],
    when: ["polling 26 minutes after its turn", ctx => ctx.poll()],
    then: ["one compact against the 150k Codex floor", (sent, ctx) => {
      expect(sent).toBe(true);
      expect(ctx.runs).toEqual([expect.objectContaining({ pane: "lsrc:4", pauseTokens: 150_000, dry: false })]);
    }],
  });
});
