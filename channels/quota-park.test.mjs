import { feature, unit, component, expect } from "bdd-vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQuotaParkFacts } from "./quota-park.mjs";
import { afterEach, vi } from "vitest";
afterEach(() => vi.useRealTimers());
import { execFileSync, exec } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createDeliveryBroker } from "../core/delivery-broker.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { createTmuxAdapter } from "../core/tmux.mjs";


// lsrc:0 2026-10-19: a pane quota recovery moved to an account with room keeps working under the floor,
// even while the five-minute snapshot still lists it on the account it left.
feature("which account a pane's quota facts come from", () => {
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
