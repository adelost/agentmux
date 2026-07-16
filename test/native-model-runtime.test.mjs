import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebUi } from "../spikes/web-ui/server.mjs";

const CLAUDE_SESSION = "11111111-1111-4111-8111-111111111111";
const CODEX_SESSION = "22222222-2222-4222-8222-222222222222";
const cleanups = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const responseJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  return { status: response.status, body: await response.json() };
};

const post = (url, body) => responseJson(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function nativeModelSpawn() {
  return (command, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let closed = false;
    let buffer = "";
    let nextId = 0;
    const emit = (...messages) => messages.forEach((message) =>
      child.stdout.write(`${JSON.stringify(message)}\n`));
    const close = () => {
      if (closed) return;
      closed = true;
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", 0));
    };
    child.kill = () => { close(); return true; };

    child.stdin.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);

        if (command === "fake-claude") {
          if (message.type === "control_request") {
            emit(
              { type: "control_response", response: { subtype: "success", request_id: message.request_id } },
              { type: "result", subtype: "error_during_execution", session_id: CLAUDE_SESSION },
            );
            close();
            continue;
          }
          const requested = args[args.indexOf("--model") + 1];
          emit(
            { type: "system", subtype: "init", session_id: CLAUDE_SESSION },
            {
              type: "assistant",
              session_id: CLAUDE_SESSION,
              message: {
                model: "claude-sonnet-4-6",
                content: [{ type: "text", text: "CLAUDE_MODEL_OK" }],
              },
            },
          );
          if (requested.includes("sonnet")) {
            emit({
              type: "result",
              subtype: "success",
              session_id: CLAUDE_SESSION,
              modelUsage: { "claude-sonnet-4-6": { contextWindow: 200_000 } },
            });
            close();
          }
          continue;
        }

        const respond = (result) => emit({ id: message.id, result });
        if (message.method === "initialize") {
          respond({ userAgent: "fake-codex" });
        } else if (message.method === "thread/start" || message.method === "thread/resume") {
          respond({ thread: { id: CODEX_SESSION } });
        } else if (message.method === "turn/start") {
          nextId += 1;
          const turnId = `turn-${nextId}`;
          respond({ turn: { id: turnId } });
          queueMicrotask(() => emit(
            { method: "turn/started", params: { threadId: CODEX_SESSION, turn: { id: turnId } } },
            {
              method: "model/rerouted",
              params: {
                threadId: CODEX_SESSION,
                turnId,
                fromModel: message.params.model,
                toModel: "gpt-5.5",
                reason: "highRiskCyberActivity",
              },
            },
          ));
        } else if (message.method === "turn/interrupt") {
          respond({});
          queueMicrotask(() => emit({
            method: "turn/completed",
            params: { threadId: CODEX_SESSION, turn: { id: message.params.turnId, status: "interrupted" } },
          }));
          setTimeout(close, 5);
        }
      }
    });
    return child;
  };
}

async function setup(spawnProcess = nativeModelSpawn()) {
  const root = mkdtempSync(join(tmpdir(), "amux-native-model-runtime-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const app = createWebUi({
    dataDir: join(root, "data"),
    homeDir: join(root, "home"),
    legacyDataDir: null,
    claudeCommand: "fake-claude",
    codexCommand: "fake-codex",
    spawnProcess,
    appendEventImpl: () => {},
  });
  const { url } = await app.listen({ port: 0 });
  cleanups.push(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const project = (await post(`${url}/api/projects`, {
    name: "Model observation",
    cwd: workspace,
    idempotencyKey: "project",
  })).body;
  return {
    url,
    project,
    root,
    workspace,
    dataDir: join(root, "data"),
    homeDir: join(root, "home"),
    app,
  };
}

function delayedCodexSpawn(calls, control) {
  return (command) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let buffer = "";
    const emit = (...messages) => messages.forEach((message) =>
      child.stdout.write(`${JSON.stringify(message)}\n`));
    const close = () => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", 0));
    };
    child.kill = () => { close(); return true; };
    expect(command).toBe("fake-codex");
    child.stdin.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        calls.push(message);
        const respond = (result) => emit({ id: message.id, result });
        if (message.method === "initialize") {
          control.release = () => respond({ userAgent: "fake-codex" });
        } else if (message.method === "thread/start") {
          respond({ thread: { id: CODEX_SESSION } });
        } else if (message.method === "turn/start") {
          respond({ turn: { id: "snapshot-turn" } });
          queueMicrotask(() => emit(
            { method: "turn/started", params: { threadId: CODEX_SESSION, turn: { id: "snapshot-turn" } } },
            { method: "item/completed", params: { threadId: CODEX_SESSION, turnId: "snapshot-turn", item: { type: "agentMessage", text: "SNAPSHOT_OK" } } },
            { method: "turn/completed", params: { threadId: CODEX_SESSION, turn: { id: "snapshot-turn", status: "completed" } } },
          ));
          setTimeout(close, 5);
        }
      }
    });
    return child;
  };
}

async function waitFor(url, projectId, agentId, predicate) {
  let lastAgent = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const projects = (await responseJson(`${url}/api/projects`)).body.projects;
    const agent = projects.find((project) => project.id === projectId)
      ?.agents.find((candidate) => candidate.id === agentId);
    lastAgent = agent ?? lastAgent;
    if (agent && predicate(agent)) return agent;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`native model state did not settle: ${JSON.stringify(lastAgent)}`);
}

describe("native runtime model truth", () => {
  it("keeps the Claude session, records the actual fallback and gates later work", async () => {
    const { url, project } = await setup();
    const created = (await post(`${url}/api/projects/${project.id}/agents`, {
      name: "Claude Fable",
      engine: "claude",
      model: "fable",
      effort: "high",
      idempotencyKey: "claude",
    })).body;

    expect((await post(`${url}/api/agents/${created.id}/messages`, {
      prompt: "observe fallback",
      attachments: [],
      idempotencyKey: "claude-turn-1",
    })).status).toBe(202);
    const stopped = await waitFor(url, project.id, created.id,
      (agent) => !agent.running && agent.modelGuard?.blocked);
    expect(stopped).toMatchObject({
      model: "fable",
      requestedModel: "fable",
      observedModel: "claude-sonnet-4-6",
      sessionId: CLAUDE_SESSION,
      modelGuard: { blocked: true },
    });
    const history = (await responseJson(`${url}/api/agents/${created.id}/history`)).body;
    expect(history.events).toContainEqual(expect.objectContaining({
      type: "web",
      subtype: "model-change",
      cause: "automatic",
      direction: "downgrade",
      policy: "stop",
    }));
    expect((await post(`${url}/api/agents/${created.id}/messages`, {
      prompt: "must remain parked",
      attachments: [],
      idempotencyKey: "claude-turn-blocked",
    })).status).toBe(423);

    const switched = await responseJson(`${url}/api/agents/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet", idempotencyKey: "claude-sonnet" }),
    });
    expect(switched.body).toMatchObject({ sessionId: CLAUDE_SESSION, model: "sonnet", modelGuard: null });
  });

  it("re-arms the guard when the same fallback repeats after an explicit model retry", async () => {
    const { url, project } = await setup();
    const created = (await post(`${url}/api/projects/${project.id}/agents`, {
      name: "Claude repeated fallback",
      engine: "claude",
      model: "fable",
      effort: "high",
      idempotencyKey: "claude-rearm",
    })).body;

    expect((await post(`${url}/api/agents/${created.id}/messages`, {
      prompt: "observe first fallback",
      attachments: [],
      idempotencyKey: "claude-rearm-turn-1",
    })).status).toBe(202);
    await waitFor(url, project.id, created.id,
      (agent) => !agent.running && agent.modelGuard?.blocked);

    const retried = await responseJson(`${url}/api/agents/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fable", idempotencyKey: "claude-rearm-clear" }),
    });
    expect(retried.body).toMatchObject({
      model: "fable",
      modelGuard: null,
      observedModel: "claude-sonnet-4-6",
      modelObservation: {
        model: "claude-sonnet-4-6",
        requestedModel: "fable",
      },
    });

    expect((await post(`${url}/api/agents/${created.id}/messages`, {
      prompt: "observe the same fallback again",
      attachments: [],
      idempotencyKey: "claude-rearm-turn-2",
    })).status).toBe(202);
    const stoppedAgain = await waitFor(url, project.id, created.id,
      (agent) => !agent.running && agent.modelGuard?.blocked);
    expect(stoppedAgain).toMatchObject({
      model: "fable",
      observedModel: "claude-sonnet-4-6",
      modelGuard: {
        blocked: true,
        requestedModel: "fable",
        observedModel: "claude-sonnet-4-6",
      },
    });
    expect((await post(`${url}/api/agents/${created.id}/messages`, {
      prompt: "must be parked after repeated fallback",
      attachments: [],
      idempotencyKey: "claude-rearm-blocked",
    })).status).toBe(423);

    const history = (await responseJson(`${url}/api/agents/${created.id}/history`)).body;
    expect(history.events.filter((event) => event.type === "web"
      && event.subtype === "model-change"
      && event.policy === "stop")).toHaveLength(2);
  });

  it("records and stops a Codex app-server reroute without changing requested model", async () => {
    const { url, project } = await setup();
    const created = (await post(`${url}/api/projects/${project.id}/agents`, {
      name: "Codex Sol",
      engine: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      idempotencyKey: "codex",
    })).body;
    expect((await post(`${url}/api/agents/${created.id}/messages`, {
      prompt: "observe reroute",
      attachments: [],
      idempotencyKey: "codex-turn-1",
    })).status).toBe(202);

    const stopped = await waitFor(url, project.id, created.id,
      (agent) => !agent.running && agent.modelGuard?.blocked);
    expect(stopped).toMatchObject({
      model: "gpt-5.6-sol",
      observedModel: "gpt-5.5",
      sessionId: CODEX_SESSION,
      modelGuard: { blocked: true },
    });
  });

  it("snapshots the Codex model before async initialization and applies a mid-turn setting next turn", async () => {
    const calls = [];
    const control = { release: null };
    const { url, project } = await setup(delayedCodexSpawn(calls, control));
    const created = (await post(`${url}/api/projects/${project.id}/agents`, {
      name: "Codex snapshot",
      engine: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      idempotencyKey: "codex-snapshot",
    })).body;
    expect((await post(`${url}/api/agents/${created.id}/messages`, {
      prompt: "hold initialization",
      attachments: [],
      idempotencyKey: "codex-snapshot-turn",
    })).status).toBe(202);
    expect(control.release).toBeTypeOf("function");

    const changed = await responseJson(`${url}/api/agents/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", idempotencyKey: "codex-next-model" }),
    });
    expect(changed.body).toMatchObject({ model: "gpt-5.5", running: true });
    control.release();
    await waitFor(url, project.id, created.id, (agent) => !agent.running);

    expect(calls.find((message) => message.method === "thread/start")?.params.model).toBe("gpt-5.6-sol");
    expect(calls.find((message) => message.method === "turn/start")?.params.model).toBe("gpt-5.6-sol");
  });

  it("does not let Codex bootstrap context steal a submitted prompt receipt after restart", async () => {
    const first = await setup();
    const created = (await post(`${first.url}/api/projects/${first.project.id}/agents`, {
      name: "Codex history",
      engine: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      idempotencyKey: "codex-history-agent",
    })).body;
    expect((await post(`${first.url}/api/agents/${created.id}/messages`, {
      prompt: "real submitted prompt",
      attachments: [],
      idempotencyKey: "codex-history-turn",
    })).status).toBe(202);
    await waitFor(first.url, first.project.id, created.id, (agent) => !agent.running);
    await first.app.close();

    const registry = JSON.parse(readFileSync(join(first.dataDir, "registry.json"), "utf8"));
    const acceptedAt = registry.receipts.messages["codex-history-turn"].acceptedAt;
    const sessionDir = join(first.homeDir, ".codex", "sessions", "2026", "07", "16");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `rollout-${CODEX_SESSION}.jsonl`), [
      JSON.stringify({
        timestamp: new Date(acceptedAt).toISOString(),
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>bootstrap context</environment_context>" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-history" },
        },
      }),
      JSON.stringify({
        timestamp: new Date(acceptedAt + 1).toISOString(),
        type: "turn_context",
        payload: { turn_id: "turn-history", model: "gpt-5.6-sol", effort: "high" },
      }),
      JSON.stringify({
        timestamp: new Date(acceptedAt + 2).toISOString(),
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "real submitted prompt" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-history" },
        },
      }),
      JSON.stringify({
        timestamp: new Date(acceptedAt + 3).toISOString(),
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "history answer" }],
        },
      }),
      JSON.stringify({
        timestamp: new Date(acceptedAt + 4).toISOString(),
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-history" },
      }),
      "",
    ].join("\n"));

    const restarted = createWebUi({
      dataDir: first.dataDir,
      homeDir: first.homeDir,
      legacyDataDir: null,
      claudeCommand: "fake-claude",
      codexCommand: "fake-codex",
      spawnProcess: nativeModelSpawn(),
      appendEventImpl: () => {},
    });
    const second = await restarted.listen({ port: 0 });
    cleanups.push(() => restarted.close());
    const history = (await responseJson(`${second.url}/api/agents/${created.id}/history`)).body;
    const users = history.events.filter((event) => event.type === "web" && event.subtype === "user");
    expect(users).toEqual([expect.objectContaining({
      text: "real submitted prompt",
      operationKey: "codex-history-turn",
    })]);
    expect(JSON.stringify(history.events)).not.toContain("bootstrap context");
  });
});
