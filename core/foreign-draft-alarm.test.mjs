import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { feature, unit, component, expect } from "bdd-vitest";
import { createForeignDraftAlarm, foreignDraftEvidence, FOREIGN_DRAFT_STATE_KEY } from "./foreign-draft-alarm.mjs";
import { startForeignDraftAlarm, parseForeignDraftConfig } from "../channels/foreign-draft-runtime.mjs";
import { createState } from "./state.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";

// Plan, smallest synthetic screen only, no live pane or real paste-cache:
// unit (<100 ms each): 11-minute report, 9/10-minute boundary, changed/cleared draft,
// own-job/predicate exclusions, no waiting work, bounded previews, target/off config,
// unreadable stored paste cannot suppress the primary stall notice.
// component (<1 s each): unique/ambiguous paste fixtures, real durable restart and
// enqueue-before-state crash, runtime capture-only adapter. Existing idle alarm stays unchanged.
const AT = Date.parse("2026-10-23T02:29:00Z");
const MINUTE = 60_000;
const DRAFT = "[Pasted text #95 +3 lines]";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const screen = (draft) => `Claude\n──────────────────── skyvw:0 ─\n❯ ${draft}\n──────────────────────────────\n`;
const waiting = (count = 25) => Array.from({ length: count }, (_, id) => ({ id: String(id), status: "pending" }));
const pane = { key: "skyvw:0", agentName: "skyvw", pane: 0, engine: "claude" };

function fixture({ draft = DRAFT, jobs = waiting(), ownsDraft = () => false, profileHome = null } = {}) {
  const fx = { clock: AT, draft, jobs, notices: [], values: {} };
  fx.state = { get: (key, fallback) => fx.values[key] ?? fallback,
    set: (key, value) => { fx.values[key] = JSON.parse(JSON.stringify(value)); } };
  fx.make = (overrides = {}) => createForeignDraftAlarm({
    target: "lsrc:0", panes: () => [pane],
    observe: async () => ({ screen: screen(fx.draft), jobs: fx.jobs, profileHome }),
    ownsDraft, state: fx.state, now: () => fx.clock,
    notify: async (text, idempotencyKey) => { fx.notices.push({ text, idempotencyKey }); },
    ...overrides,
  });
  fx.alarm = fx.make();
  fx.poll = async (minutes) => { fx.clock = AT + minutes * MINUTE; await fx.alarm.tick(); };
  return fx;
}

function pasteFixture() {
  const dir = mkdtempSync(join(tmpdir(), "foreign-draft-"));
  mkdirSync(join(dir, "paste-cache"));
  return { dir,
    add: (text, ageMinutes = 5) => {
      const path = join(dir, "paste-cache", `${hash(text).slice(0, 16)}.txt`);
      writeFileSync(path, text);
      utimesSync(path, new Date(AT - ageMinutes * MINUTE), new Date(AT - ageMinutes * MINUTE));
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

feature("foreign drafts cannot silently hold waiting deliveries", () => {
  unit("25 messages behind an eleven-minute foreign draft produce exactly one dispatcher notice", {
    given: ["skyvw:0 holding the collapsed paste at first sight", () => fixture()],
    when: ["eleven minutes pass and two polls run", async (fx) => {
      await fx.poll(0); await fx.poll(11); await fx.poll(12); return fx;
    }],
    then: ["one notice names the pane, duration, backlog, draft and non-destructive next step", (fx) => {
      expect(fx.notices).toHaveLength(1);
      expect(fx.notices[0].idempotencyKey).toBe(`foreign-draft:skyvw:0:${hash(DRAFT)}`);
      expect(fx.notices[0].text).toContain("skyvw:0: its composer has held a draft amux did not type for 11 min; 25 messages wait.");
      expect(fx.notices[0].text).toContain(`Draft: "${DRAFT}"`);
      expect(fx.notices[0].text).toContain("no unique stored copy");
      expect(fx.notices[0].text).toContain("amux never clears it: send or clear it in the pane.");
    }],
  });

  unit("nine minutes stays silent and the ten-minute boundary reports once", {
    given: ["a newly seen foreign draft", () => fixture({ draft: "unfinished instruction" })],
    when: ["polling before and at the deadline", async (fx) => {
      await fx.poll(0); await fx.poll(9); const early = [...fx.notices];
      await fx.poll(10); await fx.poll(11); return { early, notices: fx.notices };
    }],
    then: ["nothing before ten minutes and one notice afterwards", ({ early, notices }) => {
      expect(early).toEqual([]); expect(notices).toHaveLength(1);
    }],
  });

  unit("a changed draft starts a new ten-minute episode and an empty composer closes it", {
    given: ["one reported draft", async () => { const fx = fixture(); await fx.poll(0); await fx.poll(11); return fx; }],
    when: ["the text changes, waits ten minutes, then disappears", async (fx) => {
      fx.draft = "a new draft"; await fx.poll(12); await fx.poll(21);
      const beforeDeadline = fx.notices.length;
      await fx.poll(22); fx.draft = ""; await fx.poll(23);
      return { fx, beforeDeadline };
    }],
    then: ["each distinct draft reports once, never carrying the previous age", ({ fx, beforeDeadline }) => {
      expect(beforeDeadline).toBe(1); expect(fx.notices).toHaveLength(2);
      expect(fx.notices[1].idempotencyKey).toBe(`foreign-draft:skyvw:0:${hash("a new draft")}`);
      expect(fx.state.get(FOREIGN_DRAFT_STATE_KEY)).toEqual({});
    }],
  });

  unit("amux-owned, in-flight or unwanted drafts never alert", {
    given: ["each ownership guard and an empty backlog", () => [
      fixture({ jobs: [{ status: "pending", draftOwned: true }] }),
      ...["drafted", "pasting", "submitting", "submitted"].map((status) => fixture({ jobs: [{ status }] })),
      fixture({ ownsDraft: ({ agentName, pane: index, draft, jobs }) => agentName === "skyvw" && index === 0 && draft === DRAFT && jobs.length === 25 }),
      fixture({ jobs: [] }), fixture({ jobs: [{ status: "acknowledged", draftOwned: true }] }),
    ]],
    when: ["all hold their text for eleven minutes", async (cases) => {
      for (const fx of cases) { await fx.poll(0); await fx.poll(11); } return cases;
    }],
    then: ["none enqueue a notice", (cases) => expect(cases.flatMap((fx) => fx.notices)).toEqual([])],
  });

  unit("terminal ownership does not hide a foreign draft and Codex is excluded", {
    when: ["reading a Claude backlog with a completed owner and the same Codex screen", () => {
      const observation = { ...pane, screen: screen("unfinished"), jobs: [...waiting(1), { status: "acknowledged", draftOwned: true }] };
      return { claude: foreignDraftEvidence(observation), codex: foreignDraftEvidence({ ...observation, engine: "codex" }) };
    }],
    then: ["only the live Claude backlog qualifies", ({ claude, codex }) => {
      expect(claude).toMatchObject({ draft: "unfinished", waiting: 1, foreign: true }); expect(codex).toBeNull();
    }],
  });

  unit("an unreadable paste cache cannot suppress the draft-stall notice", {
    given: ["a collapsed paste whose optional stored copy is unreadable", () => {
      const fx = fixture();
      fx.logs = [];
      fx.alarm = fx.make({ readStoredPaste: async () => { throw new Error("fixture cache access denied"); },
        log: (line) => fx.logs.push(line) });
      return fx;
    }],
    when: ["the draft reaches eleven minutes", async (fx) => { await fx.poll(0); await fx.poll(11); return fx; }],
    then: ["the dispatcher hears of the stall and the cache failure is visible", (fx) => {
      expect(fx.notices).toHaveLength(1); expect(fx.notices[0].text).toContain("no unique stored copy");
      expect(fx.logs.some((line) => line.includes("fixture cache access denied"))).toBe(true);
    }],
  });

  unit("a notice bounds the draft preview to three lines and 300 characters", {
    given: ["a draft larger than the preview", () => fixture({ draft: "x".repeat(400) })],
    when: ["the deadline passes", async (fx) => { await fx.poll(0); await fx.poll(11); return fx; }],
    then: ["the text is bounded but its episode uses the complete draft", (fx) => {
      expect(fx.notices[0].text).toContain(`Draft: "${"x".repeat(300)}"`);
      expect(fx.notices[0].idempotencyKey).toBe(`foreign-draft:skyvw:0:${hash(fx.draft)}`);
    }],
  });

  component("a unique recent paste-cache match supplies only its first three lines", {
    given: ["one four-line stored paste and an older ambiguous copy", () => {
      const cache = pasteFixture();
      cache.add(`first stored line\nsecond stored line\nthird stored line\n${"z".repeat(1100)}`);
      cache.add(`old first\nold second\nold third\n${"o".repeat(1100)}`, 121);
      return { cache, fx: fixture({ profileHome: cache.dir }) };
    }],
    when: ["the foreign paste reaches eleven minutes", async (ctx) => { await ctx.fx.poll(0); await ctx.fx.poll(11); return ctx; }],
    then: ["the notice includes the unique stored preview, not its fourth line", ({ fx }) => {
      expect(fx.notices[0].text).toContain('Stored paste, first lines: "first stored line\\nsecond stored line\\nthird stored line"');
      expect(fx.notices[0].text).not.toContain("z".repeat(50));
    }],
    cleanup: ({ cache }) => cache.cleanup(),
  });

  component("two matching stored pastes never guess which content belongs to the draft", {
    given: ["two recent four-line paste-cache candidates", () => {
      const cache = pasteFixture();
      cache.add(`candidate A\nsecond\nthird\n${"a".repeat(1100)}`);
      cache.add(`candidate B\nsecond\nthird\n${"b".repeat(1100)}`);
      return { cache, fx: fixture({ profileHome: cache.dir }) };
    }],
    when: ["the deadline passes", async (ctx) => { await ctx.fx.poll(0); await ctx.fx.poll(11); return ctx; }],
    then: ["the notice declares the ambiguity without leaking either candidate", ({ fx }) => {
      expect(fx.notices[0].text).toContain("no unique stored copy");
      expect(fx.notices[0].text).not.toContain("candidate A"); expect(fx.notices[0].text).not.toContain("candidate B");
    }],
    cleanup: ({ cache }) => cache.cleanup(),
  });

  component("first sight and one queued notice survive a bridge restart even after enqueue-before-state failure", {
    given: ["a real private state file and delivery queue in a fixture directory", () => {
      const cache = pasteFixture();
      const fx = fixture({ draft: "unfinished" });
      const queue = createDeliveryQueue({ rootDir: join(cache.dir, "queue"), now: () => fx.clock });
      const state = () => createState(join(cache.dir, "state.json"));
      const make = (store = state()) => fx.make({ state: store,
        notify: (text, idempotencyKey) => queue.enqueue({ agentName: "lsrc", pane: 0, text, idempotencyKey, source: "foreign-draft" }) });
      return { cache, fx, queue, state, make };
    }],
    when: ["the instance restarts at nine minutes and crashes after queuing at eleven", async (ctx) => {
      ctx.fx.alarm = ctx.make(); await ctx.fx.poll(0);
      ctx.fx.alarm = ctx.make(); await ctx.fx.poll(9);
      const persisted = ctx.state();
      ctx.fx.alarm = ctx.make({ get: persisted.get, set: () => { throw new Error("fixture crash after enqueue"); } });
      await expect(ctx.fx.poll(11)).rejects.toThrow("fixture crash after enqueue");
      ctx.fx.alarm = ctx.make(); await ctx.fx.poll(12);
      ctx.fx.alarm = ctx.make(); await ctx.fx.poll(13); return ctx;
    }],
    then: ["one durable notice to lsrc:0, no timer reset or duplicate prompt", ({ queue }) => {
      const jobs = queue.list("lsrc", 0);
      expect(jobs).toHaveLength(1); expect(jobs[0].text).toContain("11 min; 25 messages wait");
    }],
    cleanup: ({ cache }) => cache.cleanup(),
  });

  unit("target override, idle-target fallback and the independent off switch are explicit", {
    when: ["reading operator settings", () => [
      parseForeignDraftConfig({}),
      parseForeignDraftConfig({ AMUX_IDLE_CAPACITY_TARGET: "lsrc:0", AMUX_IDLE_CAPACITY_ALERT_ENABLED: "false" }),
      parseForeignDraftConfig({ AMUX_FOREIGN_DRAFT_TARGET: "api:0", AMUX_IDLE_CAPACITY_TARGET: "lsrc:0" }),
      parseForeignDraftConfig({ AMUX_FOREIGN_DRAFT_TARGET: "lsrc:0", AMUX_FOREIGN_DRAFT_ALERT_ENABLED: "false" }),
    ]],
    then: ["only a configured target enables the alarm, with a sixty-second default", (configs) => {
      expect(configs.map((config) => config.enabled)).toEqual([false, true, true, false]);
      expect(configs[1]).toMatchObject({ target: "lsrc:0", agentName: "lsrc", pane: 0, pollMs: 60_000 });
      expect(configs[2].target).toBe("api:0");
    }],
  });

  unit("the runtime reads only Claude screens and queues its notice without typing or pressing keys", {
    given: ["an adapter spy, mixed engines and an injected clock", () => {
      const fx = { clock: AT, captured: [], writes: [], jobs: [] };
      const values = {};
      fx.runtime = startForeignDraftAlarm({
        config: parseForeignDraftConfig({ AMUX_FOREIGN_DRAFT_TARGET: "lsrc:0" }),
        agents: () => [{ name: "skyvw", panes: [{ cmd: "claude" }, { cmd: "codex" }] }, { name: "lsrc", panes: [{ cmd: "claude" }] }],
        queue: { list: (name) => name === "skyvw" ? waiting() : [], enqueue: (job) => { fx.jobs.push(job); } },
        state: { get: (key, fallback) => values[key] ?? fallback, set: (key, value) => { values[key] = value; } },
        tmux: { captureScreen: async (target) => { fx.captured.push(target); return screen(DRAFT); },
          sendKeys: (...args) => fx.writes.push(["sendKeys", ...args]),
          sendLiteral: (...args) => fx.writes.push(["sendLiteral", ...args]),
          sendEnter: (...args) => fx.writes.push(["sendEnter", ...args]) },
        now: () => fx.clock, setIntervalImpl: (_run, ms) => { fx.pollMs = ms; return { unref() {} }; },
      });
      return fx;
    }],
    when: ["the timer's alarm observes the draft and eleven minutes later checks again", async (fx) => {
      await fx.runtime.alarm.tick(); fx.clock += 11 * MINUTE; await fx.runtime.alarm.tick(); return fx;
    }],
    then: ["only read captures occur and exactly one prompt is enqueued to the dispatcher", (fx) => {
      expect(fx.pollMs).toBe(60_000); expect(fx.writes).toEqual([]);
      expect(fx.captured.every((target) => target === "skyvw:.0" || target === "lsrc:.0")).toBe(true);
      expect(fx.captured).toContain("skyvw:.0");
      expect(fx.jobs).toHaveLength(1);
      expect(fx.jobs[0]).toMatchObject({ agentName: "lsrc", pane: 0, source: "foreign-draft" });
    }],
  });
});
