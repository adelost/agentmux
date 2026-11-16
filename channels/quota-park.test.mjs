import { feature, unit, component, expect } from "bdd-vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQuotaParkFacts } from "./quota-park.mjs";
import { quotaFloorRefusal } from "../core/delivery-wake.mjs";
import { readCodexQuotaBudgeted } from "../core/codex-quota-budget.mjs";
import { afterEach, vi } from "vitest";
afterEach(() => vi.useRealTimers());
import { execFileSync, exec } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createDeliveryBroker } from "../core/delivery-broker.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { createTmuxAdapter } from "../core/tmux.mjs";
import { createBuilderCap } from "../core/delivery-builder-cap.mjs";
import { createBuilderCapFacts } from "../core/delivery-builder-cap-facts.mjs";

feature("builder cap on automatic delivery", () => {
  unit("Claude passes even when the account reader is unavailable", {
    given: ["a Claude target and a reader that throws", () => {
      const factsFor = vi.fn(async () => { throw Error("unavailable"); });
      return { factsFor, cap: createBuilderCap({ readCap: () => "1", factsFor, isCodexTarget: () => false }) };
    }],
    when: ["an automatic prompt arrives", fx => fx.cap({ kind: "prompt", status: "pending", source: "cli",
      agentName: "deep", pane: 5, metadata: { sender: "claw:5" } })],
    then: ["it passes without reading quota facts", (result, fx) => {
      expect(result).toBeNull(); expect(fx.factsFor).not.toHaveBeenCalled();
    }],
  });
  unit("a human message passes while a Codex cap check is waiting", {
    given: ["a stalled process reader on a Codex account", () => {
      let resume; const waiting = new Promise(resolve => { resume = resolve; });
      const account = { provider: "codex", inUse: ["x:1"] };
      const cap = createBuilderCap({ readCap: () => "1", factsFor: async () => ({ account, accounts: [account] }),
        isBusy: () => waiting, jobs: () => [] });
      return { cap, resume };
    }],
    when: ["a human message arrives during that check", async fx => {
      const automatic = fx.cap({ id: "a", agentName: "x", pane: 1, kind: "prompt", status: "pending",
        source: "cli", metadata: { sender: "lead:0" } });
      await new Promise(resolve => setTimeout(resolve, 10));
      const human = await Promise.race([fx.cap({ kind: "prompt", status: "pending", source: "discord", text: "Hello" }),
        new Promise(resolve => setTimeout(() => resolve("blocked"), 100))]);
      fx.resume(false); await automatic; return human;
    }],
    then: ["the person does not wait on the cap check", result => expect(result).toBeNull()],
  });
  unit("sleeping Codex targets use their next account and keep their age order", {
    given: ["one live Codex pane and two sleeping targets on the same account", () => {
      const account = { provider: "codex", profile: { key: "codex:2" }, inUse: ["x:0"] };
      const factsFor = createBuilderCapFacts({ factsFor: async () => null,
        readSnapshot: async () => ({ accounts: [account] }), configuredKey: () => "codex:2",
        queue: { targets: () => [{ agentName: "x", pane: 1 }, { agentName: "x", pane: 2 }] } });
      return factsFor;
    }],
    when: ["the first sleeping target is identified", factsFor => factsFor("x:1")],
    then: ["both sleeping targets join the account without being called working", facts => {
      expect(facts.account.inUse).toEqual(["x:0", "x:1", "x:2"]);
      expect(facts.dormantTargets).toEqual(["x:1", "x:2"]);
    }],
  });
  unit("held jobs are released oldest first and exemptions pass", {
    given: ["two idle builders and one busy builder on Codex W with cap one", () => {
      const busy = new Set(["x:0"]);
      const jobs = [1, 2].map((n) => ({ id: String(n), agentName: "x", pane: n, kind: "prompt", status: "pending",
        source: "cli", metadata: { sender: "lead:0" }, orderKey: String(n) }));
      const account = { provider: "codex", name: "Codex W", inUse: ["x:0", "x:1", "x:2"] };
      const cap = createBuilderCap({ readCap: () => "1", factsFor: async () => ({ account, accounts: [account] }),
        isBusy: async (name, pane) => busy.has(`${name}:${pane}`), jobs: () => jobs });
      return { busy, jobs, cap };
    }],
    when: ["the cap is checked before and after the busy turn ends", async fx => {
      const held = await fx.cap(fx.jobs[0]);
      const human = await fx.cap({ ...fx.jobs[1], source: "discord", text: "Please check this", metadata: {} });
      const override = await fx.cap({ ...fx.jobs[1], metadata: { sender: "lead:0", capAnyway: "urgent" } });
      const reply = await fx.cap({ ...fx.jobs[0], pane: 0 });
      fx.busy.clear();
      const younger = await fx.cap(fx.jobs[1]);
      const older = await fx.cap(fx.jobs[0]);
      return { held, human, override, reply, younger, older };
    }],
    then: ["the cap holds, exemptions pass, and the oldest job goes first", result => {
      expect(result.held).toMatch(/builder-cap/); expect(result.human).toBeNull(); expect(result.override).toBeNull(); expect(result.reply).toBeNull();
      expect(result.younger).toMatch(/builder-cap/); expect(result.older).toBeNull();
    }],
  });
  unit("a missing or unreadable cap fails open and reports one fault", {
    given: ["a missing, then unreadable cap", () => {
      let code = "ENOENT"; const logs = [];
      return { logs, cap: createBuilderCap({ readCap: () => { throw Object.assign(new Error(), { code }); },
        log: reason => logs.push(reason) }), setCode: value => { code = value; } };
    }],
    when: ["the file is read repeatedly", async fx => {
      const job = { kind: "prompt", status: "pending", source: "cli", agentName: "x", pane: 1, metadata: { sender: "lead:0" } };
      const missing = await fx.cap(job); fx.setCode("EACCES");
      return [missing, await fx.cap(job), await fx.cap(job)];
    }],
    then: ["nothing is held and the unreadable file logs once", (results, fx) => {
      expect(results).toEqual([null, null, null]); expect(fx.logs).toEqual(["EACCES"]);
    }],
  });
  unit("simultaneous starts reserve the last place once", {
    given: ["two idle Codex panes, no turns and one slot", () => {
      const jobs = [1, 2].map(pane => ({ id: String(pane), agentName: "x", pane, kind: "prompt", status: "pending",
        source: "cli", metadata: { sender: "lead:0" }, orderKey: String(pane) }));
      const account = { provider: "codex", inUse: ["x:1", "x:2"] };
      return { jobs, cap: createBuilderCap({ readCap: () => "1", factsFor: async () => ({ account, accounts: [account] }),
        isBusy: async () => false, jobs: () => jobs }) };
    }],
    when: ["the oldest and the next job both race for admission", fx => Promise.all(fx.jobs.map(fx.cap))],
    then: ["only the oldest enters", result => { expect(result[0]).toBeNull(); expect(result[1]).toMatch(/builder-cap/); }],
  });
  unit("a restarted bridge counts an uncertain in-flight job", {
    given: ["one in-flight job and one idle target on a one-slot account", () => {
      const jobs = [
        { id: "one", agentName: "x", pane: 1, kind: "prompt", status: "submitted", source: "cli" },
        { id: "two", agentName: "x", pane: 2, kind: "prompt", status: "pending", source: "cli",
          metadata: { sender: "lead:0" }, orderKey: "2" },
      ];
      const account = { provider: "codex", inUse: ["x:1", "x:2"] };
      return { jobs, cap: createBuilderCap({ readCap: () => "1", factsFor: async () => ({ account, accounts: [account] }),
        isBusy: async () => false, jobs: () => jobs }) };
    }],
    when: ["the new bridge checks the second job", fx => fx.cap(fx.jobs[1])],
    then: ["the unresolved first delivery still occupies its slot", reason => expect(reason).toMatch(/builder-cap/)],
  });
});


// lsrc:0 2026-10-19: a pane quota recovery moved to an account with room keeps working under the floor,
// even while the five-minute snapshot still lists it on the account it left.
feature("which account a pane's quota facts come from", () => {
  component("held Codex delivery sees its reset account through the actual floor", {
    given: ["25 held panes, one spent snapshot and one provider account with room", () => {
      const root = mkdtempSync(join(tmpdir(), "quota-floor-reset-"));
      const profile = { key: "codex:w", provider: "codex", home: join(root, "home") };
      const inUse = Array.from({ length: 25 }, (_, i) => `test:${i}`);
      const limits = used => [{ limitId: "codex", windows: [{ windowMinutes: 10080, usedPercent: used,
        resetsAt: "2026-11-22T00:00:00Z" }] }];
      const spent = { ok: true, provider: "codex", name: "W", profile: { key: profile.key }, inUse, limits: limits(100) };
      const provider = vi.fn(async () => ({ ...spent, limits: limits(0) }));
      const budgetDir = join(root, "budget"), now = () => Date.parse("2026-11-15T17:25:00Z");
      const facts = createQuotaParkFacts({ read: async () => ({ accounts: [spent] }), profiles: () => [profile], now,
        readPanes: async () => inUse.map(key => ({ key, engine: "codex", home: profile.home })),
        readHeldCodex: p => readCodexQuotaBudgeted(p, { budgetDir, now, read: provider, heldRefresh: true }) });
      return { root, facts, provider, now };
    }],
    when: ["all held jobs enter the real floor decision", fx => Promise.all(Array.from({ length: 25 }, (_, pane) =>
      quotaFloorRefusal({ now: fx.now, quotaFloor: { percent: 3, windowsFor: fx.facts },
        job: { agentName: "test", pane, kind: "prompt", status: "pending", costHold: true,
          lastReason: "wake-refused:quota-floor: spent" } })))],
    then: ["the reset lifts every hold with one provider read", (reasons, fx) => {
      expect(reasons).toEqual(Array(25).fill(null)); expect(fx.provider).toHaveBeenCalledTimes(1);
    }],
    cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
  unit("a held Claude account's fresh usage reaches the delivery floor", {
    given: ["a held pane on a spent shared account", () => {
      const profile = { key: "claude:1", provider: "claude", home: "/example/claude" };
      const spent = { ok: true, provider: "claude", profile: { key: profile.key }, inUse: ["test:0"],
        limits: [{ kind: "weekly_all", usedPercent: 100, resetsAt: "2026-11-22T00:00:00Z" }] };
      const readHeldClaude = vi.fn(async () => ({ ...spent, limits: [{ ...spent.limits[0], usedPercent: 0 }] }));
      const now = () => Date.parse("2026-11-15T17:25:00Z");
      const facts = createQuotaParkFacts({ read: async () => ({ accounts: [spent] }), profiles: () => [profile], now,
        readPanes: async () => [{ key: "test:0", engine: "claude", home: profile.home }], readHeldClaude });
      return { now, facts, readHeldClaude };
    }],
    when: ["the delivery floor revisits the held job", fx => quotaFloorRefusal({ now: fx.now,
      quotaFloor: { percent: 3, windowsFor: fx.facts }, job: { agentName: "test", pane: 0, kind: "prompt",
        status: "pending", costHold: true, lastReason: "wake-refused:quota-floor: spent" } })],
    then: ["the actual floor sees room", (reason, fx) => {
      expect(reason).toBeNull(); expect(fx.readHeldClaude).toHaveBeenCalledTimes(1);
    }],
  });
  unit("a failed first snapshot retries once per minute for all waiting panes", {
    given: ["one rejected read followed by an account with room", () => {
      let time = 0;
      const good = { accounts: [{ ok: true, name: "room", provider: "claude", profile: { key: "claude:1" },
        inUse: ["test:0"], limits: [] }] };
      const read = vi.fn().mockRejectedValueOnce(new Error("boot failure")).mockResolvedValue(good);
      return { read, facts: createQuotaParkFacts({ read, now: () => time, log: () => {} }), setTime: n => { time = n; } };
    }],
    when: ["many panes retry before and after the minute", async w => {
      const first = await w.facts("test:0");
      w.setTime(59_000); const early = await Promise.all(Array.from({ length: 25 }, () => w.facts("test:0")));
      const countBefore = w.read.mock.calls.length;
      w.setTime(61_000); const recovered = await Promise.all(Array.from({ length: 25 }, () => w.facts("test:0")));
      return { first, early, countBefore, recovered };
    }],
    then: ["unavailable stays held until one shared retry obtains a valid snapshot", (result, w) => {
      expect(result.first).toEqual({ unavailable: true });
      expect(result.early).toEqual(Array(25).fill({ unavailable: true }));
      expect(result.countBefore).toBe(1);
      expect(result.recovered).toEqual(Array(25).fill(expect.objectContaining({ account: expect.objectContaining({ name: "room" }) })));
      expect(w.read).toHaveBeenCalledTimes(2);
    }],
  });
  unit("a stalled shared read releases all waiters and then reads again", {
    given: ["a quota reader with one unresolved read and a later good reading, under a named fake clock", () => {
      vi.useFakeTimers();
      let finishOld;
      const good = { accounts: [{ ok: true, name: "room", provider: "claude", profile: { key: "claude:1" },
        inUse: ["lsrc:0", "claw:0"], limits: [{ kind: "weekly_all", usedPercent: 10, resetsAt: "2026-11-01T00:00:00Z" }] }] };
      const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValue(good);
      const facts = createQuotaParkFacts({ read, readTimeoutMs: 30_000, log: () => {} });
      return { facts, read, good, finish: value => finishOld(value), settled: [] };
    }],
    when: ["two panes wait through the30s read bound", async w => {
      void w.facts("lsrc:0").then(value => w.settled.push(value));
      void w.facts("claw:0").then(value => w.settled.push(value));
      await vi.advanceTimersByTimeAsync(30_000);
      return w.settled;
    }],
    then: ["both receive unavailable, the next call reads anew and the old result cannot overwrite it", async (settled, w) => {
      expect(settled).toEqual([{ unavailable: true }, { unavailable: true }]);
      expect(w.read).toHaveBeenCalledTimes(1);
      expect(await w.facts("lsrc:0")).toEqual({ unavailable: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await w.facts("lsrc:0")).toMatchObject({ account: { name: "room" } });
      expect(w.read).toHaveBeenCalledTimes(2);
      w.finish({ accounts: [] }); await Promise.resolve();
      expect(await w.facts("lsrc:0")).toMatchObject({ account: { name: "room" } });
    }],
  });
  unit("wind-down receives provider reading time and candidate accounts, never cache refresh time", {
    given: ["a snapshot read now containing an older provider observation", () => ({ accounts: [{ ok: true, provider: "claude",
      name: "Claude S", profile: { key: "claude:1" }, inUse: ["claw:1"], limits: [],
      observation: { observedAt: "2026-10-20T10:03:32Z" } }] })],
    when: ["reading the pane facts", async snapshot => ({ snapshot, facts: await createQuotaParkFacts({ read: async () => snapshot,
      profiles: () => [], now: () => Date.parse("2026-10-20T10:07:10Z") })("claw:1") })],
    then: ["the provider time survives with the shared candidate snapshot", ({ snapshot, facts }) => {
      expect(facts.observedAt).toBe(Date.parse("2026-10-20T10:03:32Z"));
      expect(facts.accounts).toEqual(snapshot.accounts);
    }],
  });
  unit("a fresh read follows the pane to the account it runs on now; the cached read keeps the snapshot", {
    given: ["claw:1 listed on Claude S at 97 %, now running from Claude A's home", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-quota-facts-"));
      const homeS = mkdtempSync(join(root, "s-")), homeA = mkdtempSync(join(root, "a-"));
      const week = (usedPercent) => [{ kind: "weekly_all", usedPercent, resetsAt: "2026-10-20T04:00:00Z" }];
      const snapshot = { accounts: [
        { ok: true, provider: "claude", name: "Claude S", profile: { key: "claude:1" }, limits: week(97), inUse: ["claw:1"] },
        { ok: true, provider: "claude", name: "Claude A", profile: { key: "claude:2" }, limits: week(40), inUse: [] },
      ] };
      const facts = createQuotaParkFacts({ read: async () => snapshot, log: () => {},
        readPanes: async () => [{ key: "claw:1", engine: "claude", home: homeA }],
        profiles: () => [{ key: "claude:1", provider: "claude", home: homeS }, { key: "claude:2", provider: "claude", home: homeA }] });
      return { root, facts };
    }],
    when: ["reading claw:1 cached, then fresh", async ({ facts }) => [await facts("claw:1"), await facts("claw:1", { fresh: true })]],
    // The provider tells the floor a Codex account, which works on past a spent window on paid credits (lsrc:0 2026-10-20).
    then: ["Claude S from the snapshot, Claude A from the live home, each with its provider", ([cached, fresh], { root }) => {
      try {
        expect(cached).toMatchObject({ account: { name: "Claude S", key: "claude:1", provider: "claude" },
          windows: [expect.objectContaining({ kind: "week", usedPercent: 97 })] });
        expect(fresh).toMatchObject({ account: { name: "Claude A", key: "claude:2", provider: "claude" },
          windows: [expect.objectContaining({ kind: "week", usedPercent: 40 })] });
      } finally { rmSync(root, { recursive: true, force: true }); }
    }],
  });
});

feature("delivery survives a stalled shared quota read", () => {
  component("the unavailable floor releases its kernel lease and a human reaches a real isolated test pane", {
    given: ["a real temporary queue and tmux cat pane, with quota-reader and model-receipt I/O doubles", async () => {
      // The same exercise can verify installed bytes after the receipted release.
      const owner = process.env.AMUX_QUOTA_PROOF_PACKAGE_ROOT;
      const load = async (path, local) => owner ? import(pathToFileURL(join(owner, path)).href) : local;
      const { createQuotaParkFacts: quotaFacts } = await load("channels/quota-park.mjs", { createQuotaParkFacts });
      const { createDeliveryQueue: deliveryQueue } = await load("core/delivery-queue.mjs", { createDeliveryQueue });
      const { createDeliveryBroker: deliveryBroker } = await load("core/delivery-broker.mjs", { createDeliveryBroker });
      const { createTmuxAdapter: tmuxAdapter } = await load("core/tmux.mjs", { createTmuxAdapter });
      const root = mkdtempSync(join(tmpdir(), "amux-quota-delivery-")), socket = join(root, "tmux.sock");
      const received = join(root, "received"), queue = deliveryQueue({ rootDir: join(root, "queue") });
      execFileSync("tmux", ["-S", socket, "new-session", "-d", "-s", "probe", `cat > '${received}'`]);
      const tmux = tmuxAdapter({ socket, exec: promisify(exec) });
      const facts = quotaFacts({ read: () => new Promise(() => {}), readTimeoutMs: 30, log: () => {} });
      const marker = "quota-boundary-local-test";
      const agent = {
        paneProcessState: async () => ({ running: true }),
        capturePromptEchoCursor: async () => ({ positions: {} }), dismissBlockingPrompt: async () => {},
        waitForPromptEcho: async () => { try { return readFileSync(received, "utf8").includes(marker); } catch { return false; } },
        sendOnly: async (_name, text, _pane, options) => {
          await options.onPasteStarted?.(); await tmux.sendLiteral("probe:.0", text); await options.onDrafted?.();
          await options.onSubmitting?.(); await tmux.sendEnter("probe:.0"); await options.onSubmitted?.();
          for (let i = 0; i < 20; i++) {
            if (await agent.waitForPromptEcho()) break;
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          return { submitted: true };
        },
      };
      const broker = deliveryBroker({ agent, queue, quotaFloor: { percent: 3, windowsFor: facts }, log: () => {} });
      const automatic = queue.enqueue({ agentName: "probe", pane: 0, text: "automatic", source: "drift-guard" });
      return { root, socket, received, queue, broker, automatic, marker };
    }],
    when: ["the stalled read times out, then the person's input uses the same session while raw quota I/O is still unresolved", async ctx => {
      let completed = false;
      const held = ctx.broker.kickTarget("probe", 0).then(() => { completed = true; });
      await Promise.race([held, new Promise(resolve => setTimeout(resolve, 500))]);
      if (!completed) return { completed };
      const lease = ctx.queue.acquireSessionLease("probe", 0); lease?.release();
      const person = ctx.queue.enqueue({ agentName: "probe", pane: 0, text: ctx.marker, source: "discord" });
      await ctx.broker.kickTarget("probe", 0);
      return { completed, lease: Boolean(lease), person: ctx.queue.read("probe", 0, person.id) };
    }],
    then: ["the automatic job remains held, the real pane receives one marker and its receipt passes without any model turn", (result, ctx) => {
      try {
        expect(result.completed).toBe(true); expect(result.lease).toBe(true);
        expect(ctx.queue.read("probe", 0, ctx.automatic.id)).toMatchObject({ status: "pending", costHold: true,
          lastReason: "wake-refused:quota-floor: fresh account reading unavailable; existing hold remains" });
        expect(result.person.status).toBe("acknowledged");
        expect(readFileSync(ctx.received, "utf8")).toBe(ctx.marker + "\n");
      } finally {
        execFileSync("tmux", ["-S", ctx.socket, "kill-server"]);
        rmSync(ctx.root, { recursive: true, force: true });
      }
    }],
  });
});
