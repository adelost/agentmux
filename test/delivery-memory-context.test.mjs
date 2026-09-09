import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { createDeliveryBroker } from "../core/delivery-broker.mjs";
import { createDeliveryMemoryContext, createPaneMemorySnapshot, resolveMemoryResponsePrompt } from "../core/delivery-memory-context.mjs";
import { readMemoryContext } from "../core/memory-context.mjs";
import { captureCodexPromptEchoCursor, isPromptInCodexJsonl, extractFromCodexJsonl } from "../core/codex-jsonl-reader.mjs";

const roots = [];
function fixture(engine = "codex") {
  const root = mkdtempSync(join(tmpdir(), "amux-lazy-memory-"));
  roots.push(root);
  mkdirSync(join(root, "memory"));
  const daily = join(root, "memory", "2026-09-07.md");
  writeFileSync(daily, "# Personal details from an unrelated pane\nDO_NOT_INJECT\n");
  let clock = Date.parse("2026-09-07T06:00:00Z"), sessionId = "first-session", compactEpoch = null;
  let accepts = true;
  const sends = [];
  const stateDir = join(root, "state");
  const queue = createDeliveryQueue({ rootDir: join(root, "queue"), recordAsk: () => {}, now: () => clock });
  const agent = {
    memorySnapshot: () => ({ engine, sessionId, sessionPath: join(root, sessionId), compactEpoch,
      context: readMemoryContext(root, { now: new Date(clock), pane: "example:2" }) }),
    capturePromptEchoCursor: async () => ({ kind: "test", positions: {} }),
    waitForPromptEcho: async (_name, _pane, text) => accepts && sends.some((sent) => sent === text),
    dismissBlockingPrompt: async () => {},
    sendOnly: async (_name, text, _pane, options) => {
      await options.onPasteStarted?.(); await options.onDrafted?.();
      await options.onSubmitting?.(); sends.push(text); await options.onSubmitted?.();
      return { submitted: true };
    },
    ensureReady: vi.fn(),
  };
  const options = { agent, queue, now: () => clock, log: () => {} };
  const memory = createDeliveryMemoryContext({ ...options, stateDir });
  const broker = () => createDeliveryBroker({ ...options, memoryContextOptions: { stateDir } });
  const enqueue = (text, extra = {}) => queue.enqueue({ agentName: "example", pane: 2, text, source: "discord", ...extra });
  const deliver = async (text) => {
    const job = enqueue(text);
    await broker().kickTarget("example", 2);
    return queue.read("example", 2, job.id);
  };
  return { root, daily, queue, agent, memory, broker, enqueue, deliver, sends, stateDir,
    advance: (ms) => { clock += ms; }, changeSession: () => { sessionId = "second-session"; },
    compact: () => { compactEpoch = new Date(clock + 1).toISOString(); },
    accepts: (value) => { accepts = value; } };
}
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("lazy memory through the existing delivery contract", () => {
  it.each([false, true])("resolves exact phone/Link replies, including a lazily created new thread: %s", async (newThread) => {
    const f = fixture();
    vi.stubEnv("HOME", f.root);
    const dir = join(f.root, ".agents", "2"), home = join(f.root, ".codex");
    vi.stubEnv("AMUX_CODEX_PROFILE_1_HOME", home);
    const sessions = join(home, "sessions"); mkdirSync(sessions, { recursive: true });
    let path = join(sessions, "rollout-canary.jsonl");
    const sessionId = "019f5ffa-d70c-73b3-98b5-c4cfae1534d3";
    const newSessionId = "01a0875a-9bc8-7a11-ad64-54dd5831d1b0";
    const oldPath = path;
    const timestamp = "2026-09-07T06:00:00.000Z";
    const record = (row) => appendFileSync(path, JSON.stringify(row) + "\n");
    record({ type: "session_meta", payload: { id: sessionId, cwd: dir, source: "cli", originator: "codex-tui" } });
    utimesSync(path, 1, 1);
    const snapshot = f.agent.memorySnapshot;
    f.agent.memorySnapshot = () => ({ ...snapshot(), sessionId, sessionPath: path });
    f.agent.capturePromptEchoCursor = async (_a, _p, text) => captureCodexPromptEchoCursor(dir, text);
    f.agent.waitForPromptEcho = async (_a, _p, text, _ms, options) => isPromptInCodexJsonl(dir, text, options);
    const send = f.agent.sendOnly;
    f.agent.sendOnly = async (...args) => {
      const result = await send(...args);
      if (newThread) {
        path = join(sessions, "rollout-new-thread.jsonl");
        record({ type: "session_meta", payload: { id: newSessionId, cwd: dir, source: "cli", originator: "codex-tui" } });
      }
      record({ timestamp, type: "event_msg", payload: { type: "user_message", message: args[1] } });
      record({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "exact reply" }] } });
      return result;
    };
    const original = "real query [amux-phone-turn:unique-id]";
    const job = await f.deliver(original);
    expect(job.status).toBe("acknowledged");
    expect(isPromptInCodexJsonl(dir, original, { cursor: job.echoCursor })).toBe(false);
    expect(isPromptInCodexJsonl(dir, job.text, { cursor: job.echoCursor })).toBe(true);
    const args = { agentName: "example", pane: 2, promptText: original, dir, dialect: "codex", queue: f.queue };
    const physical = resolveMemoryResponsePrompt(args);
    expect(physical).toBe(job.text);
    expect(job.metadata.memoryContext.sessionPath).toBe(oldPath);
    expect(extractFromCodexJsonl(dir, physical)?.items).toContainEqual({ type: "text", content: "exact reply" });
    expect(resolveMemoryResponsePrompt({ ...args, pane: 3 })).toBe(original);
    expect(resolveMemoryResponsePrompt({ ...args, identity: () => ({ sessionId: "other", path }) })).toBe(original);
    expect(resolveMemoryResponsePrompt({ ...args, promptText: "real query" })).toBe("real query");
    if (newThread) {
      // A new-session mapping needs a durable exact receipt, not just a recent
      // saved file or an old occurrence of the same message copied into it.
      for (const patch of [{ status: "submitted" }, { echoCursor: null },
        { echoNotBeforeMs: Date.parse(timestamp) + 1 }, { acknowledgedAt: Date.parse(timestamp) - 1 }]) {
        expect(resolveMemoryResponsePrompt({ ...args, queue: { list: () => [{ ...job, ...patch }] } })).toBe(original);
      }
      let calls = 0;
      expect(resolveMemoryResponsePrompt({ ...args, identity: () => ({
        sessionId: ++calls === 1 ? newSessionId : "changed-again", path,
      }) })).toBe(original);
    }
    expect(f.sends).toHaveLength(1);
  });

  it.each(["codex", "kimi"])("%s gets a bounded pointer in one real delivery and keeps exact request/receipt bytes", async (engine) => {
    const f = fixture(engine);
    const original = "Hej åäö! Read this literal `x` and $value.\nDo not start any work.";
    const job = await f.deliver(original);
    expect(job.status).toBe("acknowledged");
    expect(job.verifyText).toBe(original);
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0].startsWith(original + "\n\n")).toBe(true);
    expect(f.sends[0]).toContain("amux memory context -p example:2");
    expect(f.sends[0]).not.toContain("DO_NOT_INJECT");
    expect(Buffer.byteLength(f.sends[0]) - Buffer.byteLength(original)).toBeLessThanOrEqual(514);
    expect(f.agent.ensureReady).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(f.stateDir, readdirSync(f.stateDir)[0]))).jobId).toBe(job.id);
    await f.deliver("Second actual message");
    expect(f.sends[1]).toBe("Second actual message");
  });

  it("does nothing to dormant panes, even when the daily memory changes", async () => {
    const f = fixture();
    const broker = f.broker();
    broker.start();
    writeFileSync(f.daily, "# New daily version\n");
    await broker.kickTarget("example", 2); await broker.stop();
    expect(f.sends).toEqual([]);
    expect(existsSync(f.stateDir)).toBe(false);
    expect(f.agent.ensureReady).not.toHaveBeenCalled();
  });

  it("refreshes only on a version/session/compact change or a genuine gap between deliveries", async () => {
    const f = fixture();
    await f.deliver("first");
    f.advance(60_000); await f.deliver("recent");
    expect(f.sends.at(-1)).toBe("recent");
    writeFileSync(f.daily, "# Updated decision\n");
    await f.deliver("changed memory");
    expect(f.sends.at(-1)).toContain("[amux orientation,");
    f.compact(); await f.deliver("after compact");
    expect(f.sends.at(-1)).toContain("[amux orientation,");
    f.changeSession(); await f.deliver("new session");
    expect(f.sends.at(-1)).toContain("[amux orientation,");
    f.advance(30 * 60_000); await f.deliver("back after silence");
    expect(f.sends.at(-1)).toContain("[amux orientation,");
  });

  it("freezes retry payloads before paste and does not mark memory delivered from an ambiguous submit", async () => {
    const f = fixture(); f.accepts(false);
    const first = await f.deliver("one original request");
    expect(first.status).toBe("submitted");
    expect(existsSync(f.stateDir)).toBe(false);
    const frozen = first.text;
    writeFileSync(f.daily, "# Changed during receipt wait\n");
    expect(f.memory.prepare(first).text).toBe(frozen);
    f.advance(60_000); f.accepts(true);
    await f.broker().kickTarget("example", 2);
    expect(f.sends).toEqual([frozen]);
    expect(f.queue.read("example", 2, first.id).status).toBe("acknowledged");
    expect(existsSync(f.stateDir)).toBe(true);
    await f.deliver("next request sees changed memory");
    expect(f.sends.at(-1)).toContain("[amux orientation,");
  });

  it("repairs an old augmented unverified verdict only from exact echo, without redispatch", async () => {
    const f = fixture(); f.accepts(false);
    const job = await f.deliver("already consumed original");
    f.queue.update(job, { status: "delivered_unverified", terminalAt: 1 });
    await f.broker().kickTarget("example", 2);
    expect(f.queue.read("example", 2, job.id).status).toBe("delivered_unverified");
    f.accepts(true); await f.broker().kickTarget("example", 2);
    expect(f.queue.read("example", 2, job.id).status).toBe("acknowledged");
    expect(f.sends).toHaveLength(1);
    expect(existsSync(f.stateDir)).toBe(true);
  });

  it("never rewrites slashes, machine hints or an owned draft", () => {
    const f = fixture();
    for (const [text, extra] of [["/compact", {}], ["[drift-guard] refresh", {}],
      ["AMUX-PROBE nonce", {}], ["draft text", { kind: "prompt" }]]) {
      let job = f.enqueue(text, extra);
      if (text === "draft text") job = f.queue.update(job, { draftOwned: true, status: "drafted" });
      expect(f.memory.prepare(job).text).toBe(text);
    }
    expect(existsSync(f.stateDir)).toBe(false);
  });

  it("keeps message delivery working when optional context cannot be read", async () => {
    const f = fixture();
    f.agent.memorySnapshot = () => { throw new Error("unreadable memory"); };
    const job = await f.deliver("do not lose my message");
    expect(job.status).toBe("acknowledged");
    expect(f.sends).toEqual(["do not lose my message"]);
    expect(existsSync(f.stateDir)).toBe(false);
  });

  it("uses the existing bounded readers and rejects an identity race without creating directories", () => {
    const f = fixture();
    let moving = false, calls = 0;
    const identity = () => ({ sessionId: moving && ++calls > 1 ? "other" : "same", path: "/exact.jsonl" });
    const read = vi.fn(() => ({ jsonlFile: "/exact.jsonl", compactions: [{ timestamp: "epoch-one" }] }));
    const snapshot = createPaneMemorySnapshot({ workspace: f.root, configFor: () => ({ dir: f.root }),
      dialectFor: () => "kimi", readers: { kimi: { identity, read } } });
    expect(snapshot("example", 2)).toMatchObject({ engine: "kimi", compactEpoch: "epoch-one" });
    expect(read).toHaveBeenCalledWith(join(f.root, ".agents", "2"), { limit: 1, tailBytes: 1048576 });
    expect(existsSync(join(f.root, ".agents"))).toBe(false);
    moving = true; expect(snapshot("example", 2)).toBeNull();
    const claude = createPaneMemorySnapshot({ dialectFor: () => "claude" });
    expect(claude("example", 2)).toBeNull();
  });
});
