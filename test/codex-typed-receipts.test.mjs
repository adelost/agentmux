// Sanitized regression for authored response_item inputs without user_message.
import { feature, component, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexUserPrompt, normalizeCodexUserEvents } from "../core/codex-user-events.mjs";
import { captureCodexPromptEchoCursor, isPromptInCodexJsonl, readLastTurnsCodex,
  extractFromCodexJsonl } from "../core/codex-jsonl-reader.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { createDeliveryBroker } from "../core/delivery-broker.mjs";

const at = "2026-09-05T05:15:47.225Z";
const input = (text, kinds = ["user.text"]) => ({
  type: "response_item", timestamp: at, ordinal: 8,
  payload: { type: "message", id: "msg_fixture", role: "user",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn-fixture", content_item_kinds: kinds },
  },
});
const legacy = (text) => ({ type: "event_msg", timestamp: at, payload: { type: "user_message", message: text } });
const lifecycle = (type) => ({ type: "event_msg", timestamp: at, payload: { type, turn_id: "turn-fixture" } });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "amux-typed-receipt-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  const dir = join(home, "pane");
  const sessions = join(home, ".codex", "sessions", "2026", "09", "05");
  mkdirSync(sessions, { recursive: true });
  const file = join(sessions, "rollout-fixture.jsonl");
  const append = (...events) => appendFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(file, "");
  append({ type: "session_meta", payload: { cwd: dir, source: "cli", originator: "codex-tui" } });
  return { home, dir, file, append, cleanup: () => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    rmSync(home, { recursive: true, force: true });
  } };
}

feature("strict authored Codex receipt normalization", () => {
  unit("only supported authored input is a receipt", {
    when: ["reading exact text in different journal roles and kinds", () => {
      const user = input("do once");
      return [legacy("do once"), user,
        input("do once", ["agents_md.instructions"]), input("do once", ["environments.environment_context"]),
        input("do once", ["future.unknown"]), input("do once", []),
        { ...user, payload: { ...user.payload, role: "assistant" } },
        { ...user, payload: { ...user.payload, internal_chat_message_metadata_passthrough: undefined } },
      ].map(codexUserPrompt);
    }],
    then: ["legacy and typed user text match, but instructions and unknown forms do not", (texts) =>
      expect(texts).toEqual(["do once", "do once", null, null, null, null, null, null])],
  });

  unit("dual encodings coalesce but repeated inputs and subsequent tasks stay distinct", {
    when: ["normalizing both orderings and repeated same-text tasks", () => [
      [input("same"), legacy("same")], [legacy("same"), input("same")],
      [input("same"), input("same")], [legacy("same"), legacy("same")],
      [input("same"), legacy("same"), lifecycle("task_complete"), lifecycle("task_started"), input("same")],
    ].map((events) => normalizeCodexUserEvents(events).filter((e) => codexUserPrompt(e) !== null).length)],
    then: ["only representation twins are collapsed", (counts) => expect(counts).toEqual([1, 1, 2, 2, 2])],
  });

  component("cursor-scoped typed receipts cannot reuse an old prompt or accept a prefix", {
    given: ["the same prompt already in history before the durable cursor", () => {
      const fx = fixture();
      fx.append(input("do once"));
      return { ...fx, cursor: captureCodexPromptEchoCursor(fx.dir, "do once") };
    }],
    when: ["reading before and after a fresh exact authored event", (fx) => {
      const check = () => isPromptInCodexJsonl(fx.dir, "do once\n", { cursor: fx.cursor });
      const before = check();
      fx.append(input("do once more"), input("do once", ["agents_md.instructions"]));
      const unrelated = check();
      fx.append(input("do once"));
      const source = readFileSync(fx.file, "utf8");
      return { before, unrelated, fresh: check(), unchanged: readFileSync(fx.file, "utf8") === source };
    }],
    then: ["only the fresh exact record is accepted and the source is unchanged", (result, fx) => {
      try { expect(result).toEqual({ before: false, unrelated: false, fresh: true, unchanged: true }); }
      finally { fx.cleanup(); }
    }],
  });

  component("modern input starts the same complete tool-and-answer turn as legacy input", {
    given: ["a typed prompt with no event_msg/user_message marker", () => {
      const fx = fixture();
      fx.append(lifecycle("task_started"), input("environment", ["environments.environment_context"]),
        input("inspect repo"),
        { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"git status"}' } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Recovery finished." }] } },
        lifecycle("task_complete"));
      return fx;
    }],
    when: ["reading history and exact-prompt output through the shared reader", (fx) => ({
      history: readLastTurnsCodex(fx.dir), output: extractFromCodexJsonl(fx.dir, "inspect repo"),
    })],
    then: ["log and receipt agree on one completed authored turn with visible tools", ({ history, output }, fx) => {
      try {
        expect(history.turns).toHaveLength(1);
        expect(history.turns[0]).toMatchObject({ userPrompt: "inspect repo", isComplete: true, turnId: "turn-fixture" });
        expect(history.turns[0].items.map((item) => item.type)).toEqual(["tool", "text"]);
        expect(output.raw).toContain("Recovery finished.");
      } finally { fx.cleanup(); }
    }],
  });

  component("the broker reconciles a completed typed-input job without a second physical write", {
    given: ["a submitted job whose exact input is already beyond its durable cursor", () => {
      const fx = fixture();
      const now = Date.parse(at) + 15 * 60_000;
      const submittedAt = Date.parse(at) - 1_000;
      const queue = createDeliveryQueue({ rootDir: join(fx.home, "queue"), now: () => now });
      const job = queue.enqueue({ agentName: "fixture", pane: 4, text: "inspect once\n" });
      const cursor = captureCodexPromptEchoCursor(fx.dir, job.verifyText);
      queue.update(job, { status: "submitted", attempts: 1, submittedAt,
        echoCursor: cursor, nextAttemptAt: 0 });
      fx.append(lifecycle("task_started"), input(job.verifyText.trim()), lifecycle("task_complete"));
      const forbidden = vi.fn(async () => { throw new Error("no physical recovery permitted"); });
      const agent = {
        waitForPromptEcho: async (_name, _pane, text, _timeout, options) => isPromptInCodexJsonl(fx.dir, text, options),
        sendOnly: forbidden, sendEnter: forbidden, restartPaneExact: forbidden,
        promptTransportState: forbidden, paneProcessState: forbidden,
      };
      return { ...fx, queue, job, cursor, now, submittedAt, forbidden,
        broker: createDeliveryBroker({ agent, queue, now: () => now, notify: async () => {} }) };
    }],
    when: ["the normal broker lease and acknowledgement seam reconcile twice", async (fx) => {
      const before = readFileSync(fx.file, "utf8");
      await fx.broker.kickTarget("fixture", 4);
      await fx.broker.kickTarget("fixture", 4);
      return { job: fx.queue.read("fixture", 4, fx.job.id), unchanged: readFileSync(fx.file, "utf8") === before };
    }],
    then: ["the real receipt acknowledges attempt one without touching the source or TUI", ({ job, unchanged }, fx) => {
      try {
        expect(job).toMatchObject({ status: "acknowledged", attempts: 1, text: fx.job.text,
          submittedAt: fx.submittedAt, echoCursor: fx.cursor });
        expect(fx.forbidden).not.toHaveBeenCalled();
        expect(unchanged).toBe(true);
        expect(fx.queue.next("fixture", 4)).toBeNull();
      } finally { fx.cleanup(); }
    }],
  });

  component("a future unsupported input format cannot cause re-execution after a completed turn", {
    given: ["an ambiguous first submit with a later closed turn but no supported receipt", () => {
      const fx = fixture();
      const now = Date.parse(at) + 2 * 60_000;
      const submittedAt = Date.parse(at) - 1_000;
      const queue = createDeliveryQueue({ rootDir: join(fx.home, "queue"), now: () => now });
      const job = queue.enqueue({ agentName: "fixture", pane: 4, text: "unknown format must not repeat" });
      const cursor = captureCodexPromptEchoCursor(fx.dir, job.verifyText);
      queue.update(job, { status: "submitted", attempts: 1, submittedAt, echoCursor: cursor, nextAttemptAt: 0 });
      fx.append(lifecycle("task_started"), input(job.verifyText, ["future.unknown"]), lifecycle("task_complete"));
      const forbidden = vi.fn(async () => { throw new Error("cannot infer never-run from a missing receipt"); });
      const agent = {
        waitForPromptEcho: async (_name, _pane, text, _timeout, options) => isPromptInCodexJsonl(fx.dir, text, options),
        promptTransportState: async () => ({ state: "empty-idle", busy: false, dialect: "codex" }),
        sendOnly: forbidden, sendEnter: forbidden, restartPaneExact: forbidden, paneProcessState: forbidden,
      };
      return { ...fx, queue, job, cursor, submittedAt, forbidden,
        broker: createDeliveryBroker({ agent, queue, now: () => now, notify: async () => {} }) };
    }],
    when: ["the normal broker reconciles repeatedly past its old recovery timeout", async (fx) => {
      await fx.broker.kickTarget("fixture", 4);
      await fx.broker.kickTarget("fixture", 4);
      return fx.queue.read("fixture", 4, fx.job.id);
    }],
    then: ["attempt one is explicitly unverified and no recovery write occurs", (job, fx) => {
      try {
        expect(job).toMatchObject({ status: "delivered_unverified", attempts: 1,
          text: fx.job.text, submittedAt: fx.submittedAt, echoCursor: fx.cursor,
          metadata: { deliveryAmbiguity: "closed-codex-submit-unverified" } });
        expect(job.acknowledgedAt).toBeNull();
        expect(job.lastReason).toContain("will not be redispatched");
        expect(fx.forbidden).not.toHaveBeenCalled();
      } finally { fx.cleanup(); }
    }],
  });
});
