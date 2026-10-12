import { feature, component, expect } from "bdd-vitest";
import { createCodexCapacityRecovery, CAPACITY_CONTINUE_TEXT, CAPACITY_STATE_KEY } from "./codex-capacity-recovery.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { codexRefusals, codexLastPrompt } from "./codex-refusal-notice.mjs";
import { capacityEvents, capacityError } from "../test/fixtures/codex-capacity-2026-10-12.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const END = Date.parse(capacityEvents.at(-1).timestamp);
const SESSION = "019f5181-95b3-7e72-978b-1e74a246a86a";

function setup(reason = capacityError) {
  const root = mkdtempSync(join(tmpdir(), "amux-capacity-"));
  let clock = END;
  const data = {};
  const state = { get: (key, fallback = {}) => data[key] ?? fallback, set: (key, value) => { data[key] = value; } };
  const queue = createDeliveryQueue({ rootDir: root, now: () => clock, recordAsk: () => {} });
  const broker = { queue, enqueue: request => queue.enqueue(request), runExclusive: (_name, _pane, work) => work() };
  const transport = { dialect: "codex", state: "empty-idle", busy: false };
  let screen = "› \n gpt-6.1-sol xhigh";
  const agent = { promptTransportState: async () => transport, captureScreen: async () => screen };
  const result = { refusals: codexRefusals(capacityEvents), lastPrompt: codexLastPrompt(capacityEvents), jsonlFile: `/x/rollout-${SESSION}.jsonl` };
  const make = () => createCodexCapacityRecovery({ state, broker, agent, now: () => clock,
    readError: async () => reason, readLatestPrompt: () => result.lastPrompt, log: () => {} });
  let recovery = make();
  return { result, queue, data, transport, broker, state,
    advance: minutes => { clock = END + minutes * 60_000; },
    screen: value => { screen = value; },
    restart: () => { recovery = make(); },
    tick: () => recovery.tick({ name: "lsrc", pane: 5, result }),
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

feature("bounded automatic recovery after an exact Codex capacity stop", () => {
  component("the actual mid-turn stop waits two minutes and enqueues once across restart", {
    given: ["the sanitized October 12 stop and a real durable queue", setup],
    when: ["ticking before, at, and after the deadline across restart", async fx => {
      await fx.tick(); fx.advance(1); await fx.tick();
      expect(fx.queue.list("lsrc", 5)).toHaveLength(0);
      fx.advance(2); await fx.tick(); fx.restart(); await fx.tick();
      return fx.queue.list("lsrc", 5);
    }],
    then: ["one exact continuation, unchanged model and account", jobs => {
      expect(jobs).toHaveLength(1);
      expect(jobs[0].text).toBe(CAPACITY_CONTINUE_TEXT);
      expect(jobs[0].source).toBe("codex-capacity-recovery");
    }], cleanup: fx => fx.cleanup(),
  });

  component("own refused continuations cannot reset the three-attempt budget", {
    given: ["one capacity episode", setup],
    when: ["refusing each exact continuation and polling past ten minutes", async fx => {
      for (const minute of [2, 5, 10, 20]) {
        fx.advance(minute); await fx.tick();
        const job = fx.queue.list("lsrc", 5).at(-1);
        fx.queue.update(job, { status: "acknowledged", submittedAt: END + minute * 60_000, acknowledgedAt: END + minute * 60_000 });
        fx.result.lastPrompt = { timestamp: new Date(END + minute * 60_000).toISOString(), text: job.text };
        fx.result.refusals.push({ id: `retry-${minute}`, timestamp: new Date(END + minute * 60_000 + 1000).toISOString(), promptAt: fx.result.lastPrompt.timestamp });
        fx.restart();
      }
      return fx.queue.list("lsrc", 5);
    }],
    then: ["only three durable continuation identities exist", jobs => expect(jobs).toHaveLength(3)],
    cleanup: fx => fx.cleanup(),
  });

  for (const reason of ["You've hit your usage limit. Try again later.", "Unknown model", null]) {
    component(`a non-capacity refusal (${reason}) sends nothing`, {
      given: ["a provider refusal", () => setup(reason)],
      when: ["waiting beyond all retry times", async fx => { fx.advance(20); await fx.tick(); return fx.queue.list("lsrc", 5); }],
      then: ["no capacity job", jobs => expect(jobs).toHaveLength(0)], cleanup: fx => fx.cleanup(),
    });
  }

  for (const held of ["working", "dialog", "delivery", "new-input", "model-change"]) {
    component(`${held} prevents a continuation`, {
      given: ["a scheduled capacity episode", setup],
      when: ["changing the target before the deadline", async fx => {
        await fx.tick(); fx.advance(2);
        if (held === "working") fx.transport.busy = true;
        if (held === "dialog") fx.screen("Resume paused goal?\n› 1. Resume goal\n2. Leave paused\nPress enter to confirm or esc to go back");
        if (held === "delivery") fx.broker.enqueue({ agentName: "lsrc", pane: 5, text: "Human input", source: "discord" });
        if (held === "new-input") fx.result.lastPrompt = { timestamp: new Date(END + 60_000).toISOString(), text: "kör" };
        if (held === "model-change") fx.state.set("codex_model_by_pane", { "lsrc:5": { model: "different" } });
        await fx.tick(); return fx.queue.list("lsrc", 5).filter(job => job.source === "codex-capacity-recovery");
      }], then: ["no automatic prompt", jobs => expect(jobs).toHaveLength(0)],
      cleanup: fx => fx.cleanup(),
    });
  }
});
