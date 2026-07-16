import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWebUi } from "../spikes/web-ui/server.mjs";

const SESSION = "11111111-1111-4111-8111-111111111111";
const LIMIT = "You've hit your session limit · resets 12am (Europe/Stockholm)";
const cleanups = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const post = async (url, path, body) => {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

const get = async (url, path) => {
  const response = await fetch(`${url}${path}`);
  return { status: response.status, body: await response.json() };
};

async function waitFor(url, projectId, agentId, predicate, message = "native quota state did not settle") {
  let last = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const projects = (await get(url, "/api/projects")).body.projects;
    last = projects.find((project) => project.id === projectId)
      ?.agents.find((agent) => agent.id === agentId) ?? last;
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`);
}

function quotaThenSuccessSpawn(calls, { unsafe = false } = {}) {
  return (command, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    let buffer = "";
    const emit = (...events) => events.forEach((event) =>
      child.stdout.write(`${JSON.stringify(event)}\n`));
    const close = (code) => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", code));
    };
    const call = { command, args, messages: [] };
    calls.push(call);
    const first = calls.length === 1;

    child.stdin.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        call.messages.push(message);
        if (!first) {
          emit(
            { type: "system", subtype: "init", session_id: SESSION },
            {
              type: "assistant",
              session_id: SESSION,
              message: { model: "claude-opus-4-8", content: [{ type: "text", text: "RECOVERED_OK" }] },
            },
            {
              type: "result", subtype: "success", is_error: false, session_id: SESSION,
              usage: { input_tokens: 1, output_tokens: 1 },
              modelUsage: { "claude-opus-4-8": { inputTokens: 1, outputTokens: 1, contextWindow: 200_000 } },
            },
          );
          close(0);
          continue;
        }
        emit({ type: "system", subtype: "init", session_id: SESSION });
        if (unsafe) emit({
          type: "assistant",
          session_id: SESSION,
          message: { model: "claude-opus-4-8", content: [{ type: "text", text: "I already changed something." }] },
        });
        emit(
          {
            type: "assistant",
            error: "rate_limit",
            session_id: SESSION,
            uuid: "quota-assistant",
            timestamp: "2026-07-16T19:13:37.132Z",
            message: { model: "<synthetic>", content: [{ type: "text", text: LIMIT }] },
          },
          {
            type: "result",
            subtype: "success",
            is_error: true,
            api_error_status: 429,
            terminal_reason: "api_error",
            session_id: SESSION,
            uuid: "quota-result",
            num_turns: 1,
            result: LIMIT,
            usage: unsafe ? { input_tokens: 1 } : {
              input_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 0,
            },
            modelUsage: {},
          },
        );
        close(1);
      }
    });
    return child;
  };
}

function runtime(root, calls, options = {}) {
  return createWebUi({
    dataDir: join(root, "data"),
    homeDir: join(root, "home"),
    legacyDataDir: null,
    claudeCommand: "fake-claude",
    codexCommand: "fake-codex",
    spawnProcess: quotaThenSuccessSpawn(calls, options),
    readQuotaSnapshot: options.readQuotaSnapshot,
    nativeQuotaPollMs: 5,
    appendEventImpl: () => {},
  });
}

describe("native Claude quota recovery", () => {
  it("persists a pre-execution 429 and completes the same operation after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-native-quota-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
    const calls = [];
    const exhausted = async () => ({
      claude: { ok: true, engine: "claude", limits: [{ kind: "session", usedPercent: 100 }] },
      codex: { ok: false, engine: "codex", error: "unused" },
    });
    const first = runtime(root, calls, { readQuotaSnapshot: exhausted });
    const firstUrl = (await first.listen({ port: 0 })).url;
    const project = (await post(firstUrl, "/api/projects", {
      name: "Native quota", cwd: workspace, idempotencyKey: "project",
    })).body;
    const agent = (await post(firstUrl, `/api/projects/${project.id}/agents`, {
      name: "watch:0", engine: "claude", model: "claude-opus-4-8",
      address: { session: "watch", pane: 0 }, permissionMode: "automation",
      idempotencyKey: "agent",
    })).body;
    const prompt = "Finish the same feature after quota returns";
    expect((await post(firstUrl, `/api/agents/${agent.id}/messages`, {
      prompt, attachments: [], idempotencyKey: "delivery:quota",
    })).status).toBe(202);
    const waiting = await waitFor(firstUrl, project.id, agent.id, (value) => value.quotaWaiting);
    expect(waiting).toMatchObject({ backend: "native", running: false, quotaWaiting: true });
    expect(calls).toHaveLength(1);
    const waitingHistory = (await get(firstUrl, `/api/agents/${agent.id}/history`)).body;
    expect(waitingHistory.events.filter((event) => event.type === "web" && event.subtype === "user"))
      .toHaveLength(1);
    expect(waitingHistory.events.map((event) => event.subtype)).toContain("quota-waiting");
    await first.close();

    const available = async () => ({
      claude: { ok: true, engine: "claude", limits: [{ kind: "session", usedPercent: 14 }] },
      codex: { ok: false, engine: "codex", error: "unused" },
    });
    const second = runtime(root, calls, { readQuotaSnapshot: available });
    cleanups.push(async () => second.close());
    const secondUrl = (await second.listen({ port: 0 })).url;
    await waitFor(secondUrl, project.id, agent.id,
      (value) => !value.running && !value.quotaWaiting && value.queuedMessages === 0);

    expect(calls).toHaveLength(2);
    expect(calls[0].messages[0].message.content).toBe(prompt);
    expect(calls[1].messages[0].message.content).toContain("[AMUX AUTOMATIC QUOTA RECOVERY");
    expect(calls[1].messages[0].message.content).not.toContain(prompt);
    expect(calls[1].args).toContain("--resume");
    expect(calls[1].args).toContain(SESSION);
    const history = (await get(secondUrl, `/api/agents/${agent.id}/history`)).body;
    expect(history.operations).toEqual([expect.objectContaining({
      operationKey: "delivery:quota", code: 0, sessionId: SESSION,
    })]);
    expect(history.events.map((event) => event.subtype)).toEqual(expect.arrayContaining([
      "quota-recovered", "quota-retry", "turn-done",
    ]));
    const registry = JSON.parse(readFileSync(join(root, "data", "registry.json"), "utf8"));
    expect(registry.queuedMessages).toEqual({});
    expect(registry.receipts.messages["delivery:quota"]).toMatchObject({ code: 0 });
  });

  it("never replays a quota turn after assistant work or token use", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-native-quota-unsafe-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const calls = [];
    const app = runtime(root, calls, {
      unsafe: true,
      readQuotaSnapshot: async () => ({
        claude: { ok: true, engine: "claude", limits: [{ kind: "session", usedPercent: 0 }] },
        codex: { ok: false, engine: "codex", error: "unused" },
      }),
    });
    cleanups.push(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
    const url = (await app.listen({ port: 0 })).url;
    const project = (await post(url, "/api/projects", {
      name: "Unsafe retry", cwd: workspace, idempotencyKey: "project",
    })).body;
    const agent = (await post(url, `/api/projects/${project.id}/agents`, {
      name: "watch:0", engine: "claude", idempotencyKey: "agent",
    })).body;
    await post(url, `/api/agents/${agent.id}/messages`, {
      prompt: "Do not duplicate this", attachments: [], idempotencyKey: "delivery:unsafe",
    });
    await waitFor(url, project.id, agent.id, (value) => !value.running);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(calls).toHaveLength(1);
    const history = (await get(url, `/api/agents/${agent.id}/history`)).body;
    expect(history.operations[0]).toMatchObject({ operationKey: "delivery:unsafe", code: 1 });
    expect(history.agent.quotaWaiting).toBe(false);
  });
});
