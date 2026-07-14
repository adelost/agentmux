import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectDir } from "../core/claude-paths.mjs";
import { createWebUi } from "../spikes/web-ui/server.mjs";

const CLAUDE_SESSION = "11111111-1111-4111-8111-111111111111";
const CODEX_SESSION = "22222222-2222-4222-8222-222222222222";
const cleanups = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function fakeSpawn(calls) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let closed = false;
    const close = (code = 0) => {
      if (closed) return;
      closed = true;
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", code));
    };
    child.kill = () => { close(0); return true; };
    const call = { command, args: [...args], options, messages: [] };
    calls.push(call);
    const emit = (...messages) => {
      for (const message of messages) child.stdout.write(`${JSON.stringify(message)}\n`);
    };

    if (command === "fake-claude" && args.includes("--fork-session")) {
      const prompt = args[args.indexOf("-p") + 1];
      queueMicrotask(() => {
        emit({ type: "result", subtype: "success", result: `SIDE_OK: ${prompt.split("\n").at(-1)}` });
        close();
      });
      return child;
    }

    let buffer = "";
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

        if (command === "fake-claude") {
          if (message.type === "control_request") {
            emit(
              { type: "control_response", response: { subtype: "success", request_id: message.request_id } },
              { type: "result", subtype: "error_during_execution", is_error: true, session_id: CLAUDE_SESSION },
            );
            close();
          } else if (message.message?.content === "/compact") {
            emit(
              { type: "system", subtype: "init", session_id: CLAUDE_SESSION },
              {
                type: "system",
                subtype: "compact_boundary",
                session_id: CLAUDE_SESSION,
                compact_metadata: { trigger: "manual", pre_tokens: 130_000, post_tokens: 30_000 },
              },
              { type: "result", subtype: "success", session_id: CLAUDE_SESSION, result: "" },
            );
            close();
          } else if (message.message?.content !== "WAIT_FOR_INTERRUPT") {
            emit(
              { type: "system", subtype: "init", session_id: CLAUDE_SESSION },
              {
                type: "assistant",
                session_id: CLAUDE_SESSION,
                message: { content: [{ type: "text", text: "CLAUDE_OK" }] },
              },
              {
                type: "result",
                subtype: "success",
                session_id: CLAUDE_SESSION,
                duration_ms: 12,
                total_cost_usd: 0,
                usage: {
                  input_tokens: 10,
                  cache_read_input_tokens: 179_988,
                  output_tokens: 2,
                  iterations: [{
                    input_tokens: 10,
                    cache_read_input_tokens: 119_988,
                    cache_creation_input_tokens: 0,
                    output_tokens: 2,
                  }],
                },
                modelUsage: {
                  "claude-opus-4-8": {
                    inputTokens: 10,
                    cacheReadInputTokens: 179_988,
                    cacheCreationInputTokens: 0,
                    outputTokens: 2,
                    contextWindow: 200_000,
                  },
                },
              },
            );
            close();
          }
          continue;
        }

        const respond = (result) => emit({ id: message.id, result });
        if (message.method === "initialize") {
          respond({ userAgent: "fake-codex" });
        } else if (message.method === "thread/resume" && "excludeTurns" in message.params) {
          emit({
            id: message.id,
            error: { code: -32602, message: "thread/resume.excludeTurns requires experimentalApi capability" },
          });
        } else if (message.method === "thread/start" || message.method === "thread/resume") {
          respond({ thread: { id: CODEX_SESSION } });
          emit({
            method: "thread/tokenUsage/updated",
            params: {
              threadId: CODEX_SESSION,
              turnId: "previous-turn",
              tokenUsage: {
                total: { totalTokens: 120_000, inputTokens: 119_000, outputTokens: 1_000 },
                last: { totalTokens: 120_000, inputTokens: 119_000, outputTokens: 1_000 },
                modelContextWindow: 200_000,
              },
            },
          });
        } else if (message.method === "turn/start") {
          respond({ turn: { id: "codex-turn" } });
          const prompt = message.params.input.find((item) => item.type === "text")?.text;
          if (prompt !== "WAIT_FOR_INTERRUPT") queueMicrotask(() => emit(
            { method: "turn/started", params: { threadId: CODEX_SESSION, turn: { id: "codex-turn" } } },
            { method: "item/agentMessage/delta", params: { threadId: CODEX_SESSION, turnId: "codex-turn", delta: "CODEX_OK" } },
            { method: "item/completed", params: { threadId: CODEX_SESSION, turnId: "codex-turn", item: { type: "agentMessage", text: "CODEX_OK" } } },
            {
              method: "thread/tokenUsage/updated",
              params: {
                threadId: CODEX_SESSION,
                turnId: "codex-turn",
                tokenUsage: {
                  total: { totalTokens: 121_000, inputTokens: 119_998, outputTokens: 1_002 },
                  last: { totalTokens: 120_000, inputTokens: 119_998, outputTokens: 2 },
                  modelContextWindow: 200_000,
                },
              },
            },
            { method: "turn/completed", params: { threadId: CODEX_SESSION, turn: { id: "codex-turn", status: "completed", durationMs: 15 } } },
          ));
        } else if (message.method === "thread/compact/start") {
          respond({});
          queueMicrotask(() => emit(
            { method: "turn/started", params: { threadId: CODEX_SESSION, turn: { id: "compact-turn" } } },
            {
              method: "thread/tokenUsage/updated",
              params: {
                threadId: CODEX_SESSION,
                turnId: "compact-turn",
                tokenUsage: {
                  total: { totalTokens: 121_000, inputTokens: 119_998, outputTokens: 1_002 },
                  last: { totalTokens: 30_000, inputTokens: 30_000, outputTokens: 0 },
                  modelContextWindow: 200_000,
                },
              },
            },
            { method: "item/completed", params: { threadId: CODEX_SESSION, turnId: "compact-turn", item: { type: "contextCompaction" } } },
            { method: "turn/completed", params: { threadId: CODEX_SESSION, turn: { id: "compact-turn", status: "completed", durationMs: 20 } } },
          ));
        } else if (message.method === "turn/interrupt") {
          respond({});
          queueMicrotask(() => emit({
            method: "turn/completed",
            params: { threadId: CODEX_SESSION, turn: { id: "codex-turn", status: "interrupted", durationMs: 5 } },
          }));
        }
      }
    });
    return child;
  };
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const type = response.headers.get("content-type") || "";
  const body = type.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body, headers: response.headers };
}

const postJson = (url, body) => request(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function setup(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-web-ui-"));
  const workspace = join(root, "workspace");
  const dataDir = join(root, "data");
  const homeDir = join(root, "home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const calls = [];
  const app = createWebUi({
    dataDir,
    homeDir,
    legacyDataDir: null,
    claudeCommand: "fake-claude",
    codexCommand: "fake-codex",
    spawnProcess: fakeSpawn(calls),
    ...overrides,
  });
  const { url } = await app.listen({ port: 0 });
  cleanups.push(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, workspace, dataDir, homeDir, calls, app, url };
}

async function createProject(url, workspace, key = "project-key") {
  const response = await postJson(`${url}/api/projects`, {
    name: "Testprojekt",
    cwd: workspace,
    idempotencyKey: key,
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function createAgent(url, project, engine, key = `${engine}-agent-key`) {
  const response = await postJson(`${url}/api/projects/${project.id}/agents`, {
    name: engine === "claude" ? "Claude agent" : "Codex agent",
    engine,
    model: engine === "claude" ? "claude-opus-4-8" : "gpt-5.6-sol",
    idempotencyKey: key,
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function waitForIdle(url, projectId, agentId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await request(`${url}/api/projects`);
    const agent = response.body.projects.find((item) => item.id === projectId)
      ?.agents.find((item) => item.id === agentId);
    if (agent && !agent.running && agent.sessionId) return agent;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("agent did not become idle");
}

async function waitForAgent(url, projectId, agentId, predicate, message = "agent condition timed out") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(`${url}/api/projects`);
    const agent = response.body.projects.find((item) => item.id === projectId)
      ?.agents.find((item) => item.id === agentId);
    if (agent && predicate(agent)) return agent;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(message);
}

describe("AMUX Code project and agent registry", () => {
  it("creates a project, inherits its cwd and rejects changed idempotent retries", async () => {
    const { url, workspace } = await setup();
    const project = await createProject(url, workspace);

    const replay = await postJson(`${url}/api/projects`, {
      name: "Testprojekt",
      cwd: workspace,
      idempotencyKey: "project-key",
    });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(project.id);
    expect(replay.body.replayed).toBe(true);

    const conflict = await postJson(`${url}/api/projects`, {
      name: "Annat projekt",
      cwd: workspace,
      idempotencyKey: "project-key",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("idempotency-key-conflict");

    const concurrentPayload = {
      name: "Samtidigt projekt",
      cwd: workspace,
      idempotencyKey: "concurrent-project-key",
    };
    const concurrent = await Promise.all([
      postJson(`${url}/api/projects`, concurrentPayload),
      postJson(`${url}/api/projects`, concurrentPayload),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(new Set(concurrent.map((response) => response.body.id))).toHaveLength(1);

    const agent = await createAgent(url, project, "claude");
    expect(agent.cwd).toBe(workspace);
    const list = await request(`${url}/api/projects`);
    expect(list.body.projects[0].agents[0].id).toBe(agent.id);
    expect(list.body.projects[0].communicationPolicy).toMatchObject({
      read: "all_agents",
      send: { mode: "open" },
      enforced: false,
    });
  });

  it("runs Claude and Codex in the project, resumes sessions and de-duplicates messages", async () => {
    const { url, workspace, calls } = await setup();
    const project = await createProject(url, workspace);
    const claude = await createAgent(url, project, "claude");
    const codex = await createAgent(url, project, "codex");

    const upload = await request(`${url}/api/projects/${project.id}/uploads?name=note.txt`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "important file",
    });
    expect(upload.status).toBe(201);

    const first = await postJson(`${url}/api/agents/${claude.id}/messages`, {
      prompt: "hello claude",
      attachments: [{ path: upload.body.path, name: "note.txt" }],
      idempotencyKey: "claude-turn-1",
    });
    expect(first.status).toBe(202);
    await waitForIdle(url, project.id, claude.id);
    expect(calls[0].command).toBe("fake-claude");
    expect(calls[0].options.cwd).toBe(workspace);
    expect(calls[0].args).toContain("acceptEdits");
    expect(calls[0].args).toContain("--effort");
    expect(calls[0].messages[0].message.content).toContain(upload.body.path);

    const secondBody = { prompt: "continue", attachments: [], idempotencyKey: "claude-turn-2" };
    expect((await postJson(`${url}/api/agents/${claude.id}/messages`, secondBody)).status).toBe(202);
    await waitForIdle(url, project.id, claude.id);
    expect(calls[1].args).toContain("--resume");
    expect(calls[1].args).toContain(CLAUDE_SESSION);
    const callCount = calls.length;
    const replay = await postJson(`${url}/api/agents/${claude.id}/messages`, secondBody);
    expect(replay.body.replayed).toBe(true);
    expect(calls).toHaveLength(callCount);
    const conflict = await postJson(`${url}/api/agents/${claude.id}/messages`, {
      ...secondBody,
      prompt: "changed",
    });
    expect(conflict.status).toBe(409);

    expect((await postJson(`${url}/api/agents/${codex.id}/messages`, {
      prompt: "hello codex",
      attachments: [],
      idempotencyKey: "codex-turn-1",
    })).status).toBe(202);
    await waitForIdle(url, project.id, codex.id);
    const codexCall = calls.find((call) => call.command === "fake-codex");
    expect(codexCall.options.cwd).toBe(workspace);
    expect(codexCall.args).toEqual(["app-server", "--stdio"]);
    expect(codexCall.messages.find((message) => message.method === "thread/start")?.params.cwd).toBe(workspace);
    expect(codexCall.messages.find((message) => message.method === "turn/start")?.params.effort).toBe("medium");

    const history = await request(`${url}/api/agents/${codex.id}/history`);
    expect(history.body.events.some((event) => event.message?.content?.[0]?.text === "CODEX_OK")).toBe(true);

    expect((await postJson(`${url}/api/agents/${codex.id}/messages`, {
      prompt: "continue codex",
      attachments: [],
      idempotencyKey: "codex-turn-2",
    })).status).toBe(202);
    await waitForIdle(url, project.id, codex.id);
    const codexResumeCall = calls.filter((call) => call.command === "fake-codex").at(-1);
    const resumeRequest = codexResumeCall.messages.find((message) => message.method === "thread/resume");
    expect(resumeRequest?.params).toMatchObject({ threadId: CODEX_SESSION, cwd: workspace });
    expect(resumeRequest?.params).not.toHaveProperty("excludeTurns");
  });

  it("persists effort changes and applies them to the next Claude and Codex turns", async () => {
    const { url, workspace, calls } = await setup();
    const project = await createProject(url, workspace);
    const claude = await createAgent(url, project, "claude");
    const codex = await createAgent(url, project, "codex");
    expect(claude.effort).toBe("medium");
    expect(codex.effort).toBe("medium");

    const changeClaude = await request(`${url}/api/agents/${claude.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ effort: "high", idempotencyKey: "claude-effort-high" }),
    });
    expect(changeClaude.status).toBe(200);
    expect(changeClaude.body.effort).toBe("high");
    const replay = await request(`${url}/api/agents/${claude.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ effort: "high", idempotencyKey: "claude-effort-high" }),
    });
    expect(replay.body.replayed).toBe(true);
    expect((await request(`${url}/api/agents/${codex.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ effort: "xhigh", idempotencyKey: "codex-effort-xhigh" }),
    })).status).toBe(200);

    await postJson(`${url}/api/agents/${claude.id}/messages`, {
      prompt: "effort claude",
      attachments: [],
      idempotencyKey: "effort-claude-turn",
    });
    await waitForIdle(url, project.id, claude.id);
    const claudeCall = calls.find((call) => call.command === "fake-claude" && !call.args.includes("--fork-session"));
    expect(claudeCall.args.slice(claudeCall.args.indexOf("--effort"), claudeCall.args.indexOf("--effort") + 2))
      .toEqual(["--effort", "high"]);

    await postJson(`${url}/api/agents/${codex.id}/messages`, {
      prompt: "effort codex",
      attachments: [],
      idempotencyKey: "effort-codex-turn",
    });
    await waitForIdle(url, project.id, codex.id);
    const codexCall = calls.find((call) => call.command === "fake-codex");
    expect(codexCall.messages.find((message) => message.method === "turn/start")?.params.effort).toBe("xhigh");
  });

  it("keeps an in-flight effort stable and applies a mid-turn change to the following turn", async () => {
    const { url, workspace, calls } = await setup();
    const project = await createProject(url, workspace);
    const claude = await createAgent(url, project, "claude");
    const codex = await createAgent(url, project, "codex");

    for (const [agent, key] of [[claude, "claude"], [codex, "codex"]]) {
      expect((await postJson(`${url}/api/agents/${agent.id}/messages`, {
        prompt: "WAIT_FOR_INTERRUPT",
        attachments: [],
        idempotencyKey: `${key}-medium-running`,
      })).status).toBe(202);
      expect((await request(`${url}/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ effort: "high", idempotencyKey: `${key}-running-high` }),
      })).status).toBe(200);

      let interrupt;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        interrupt = await postJson(`${url}/api/agents/${agent.id}/interrupt`, {
          idempotencyKey: `${key}-running-interrupt`,
        });
        if (interrupt.status === 202) break;
        expect(interrupt.body.error).toBe("interrupt-not-ready");
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(interrupt.status).toBe(202);
      await waitForIdle(url, project.id, agent.id);

      expect((await postJson(`${url}/api/agents/${agent.id}/messages`, {
        prompt: `${key} after effort change`,
        attachments: [],
        idempotencyKey: `${key}-after-running-high`,
      })).status).toBe(202);
      await waitForIdle(url, project.id, agent.id);

      const engineCalls = calls.filter((call) => call.command === `fake-${key}`);
      if (key === "claude") {
        expect(engineCalls[0].args.slice(engineCalls[0].args.indexOf("--effort"), engineCalls[0].args.indexOf("--effort") + 2))
          .toEqual(["--effort", "medium"]);
        expect(engineCalls.at(-1).args.slice(engineCalls.at(-1).args.indexOf("--effort"), engineCalls.at(-1).args.indexOf("--effort") + 2))
          .toEqual(["--effort", "high"]);
      } else {
        expect(engineCalls[0].messages.find((message) => message.method === "turn/start")?.params.effort)
          .toBe("medium");
        expect(engineCalls.at(-1).messages.find((message) => message.method === "turn/start")?.params.effort)
          .toBe("high");
      }
    }
  });

  it("tracks exact context and manually compacts native Claude and Codex sessions", async () => {
    const { url, workspace } = await setup();
    const project = await createProject(url, workspace);
    const claude = await createAgent(url, project, "claude");
    const codex = await createAgent(url, project, "codex");

    for (const [agent, key] of [[claude, "claude"], [codex, "codex"]]) {
      await postJson(`${url}/api/agents/${agent.id}/messages`, {
        prompt: `context ${key}`,
        attachments: [],
        idempotencyKey: `${key}-context-turn`,
      });
      const before = await waitForIdle(url, project.id, agent.id);
      expect(before.context).toMatchObject({ usedTokens: 120_000, windowTokens: 200_000, percent: 60 });
      if (agent.engine === "claude") expect(before.context.processedTokens).toBe(180_000);

      const compact = await postJson(`${url}/api/agents/${agent.id}/compact`, {
        idempotencyKey: `${key}-compact`,
      });
      expect(compact.status).toBe(202);
      const after = await waitForAgent(url, project.id, agent.id,
        (item) => !item.running && item.context?.usedTokens === 30_000,
        `${key} did not compact`);
      expect(after.context.percent).toBe(15);
    }
  });

  it("soft-interrupts active Claude and Codex turns without deleting their native sessions", async () => {
    const { url, workspace } = await setup();
    const project = await createProject(url, workspace);
    const claude = await createAgent(url, project, "claude");
    const codex = await createAgent(url, project, "codex");

    for (const [agent, key] of [[claude, "claude"], [codex, "codex"]]) {
      expect((await postJson(`${url}/api/agents/${agent.id}/messages`, {
        prompt: "WAIT_FOR_INTERRUPT",
        attachments: [],
        idempotencyKey: `${key}-wait-turn`,
      })).status).toBe(202);

      const interruptKey = `${key}-interrupt`;
      let interrupt;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        interrupt = await postJson(`${url}/api/agents/${agent.id}/interrupt`, {
          idempotencyKey: interruptKey,
        });
        if (interrupt.status === 202) break;
        expect(interrupt.body.error).toBe("interrupt-not-ready");
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(interrupt.status).toBe(202);
      const idle = await waitForIdle(url, project.id, agent.id);
      expect(idle.sessionId).toBe(key === "claude" ? CLAUDE_SESSION : CODEX_SESSION);
      const replay = await postJson(`${url}/api/agents/${agent.id}/interrupt`, {
        idempotencyKey: interruptKey,
      });
      expect(replay.status).toBe(200);
      expect(replay.body.replayed).toBe(true);
      const history = await request(`${url}/api/agents/${agent.id}/history`);
      expect(history.body.events.some((event) => event.subtype === "interrupted")).toBe(true);
    }
  });

  it("auto-compacts context at 60 percent only after the configured idle window", async () => {
    const { url, workspace, calls } = await setup({ autoCompactIdleMs: 30 });
    const project = await createProject(url, workspace);
    const claude = await createAgent(url, project, "claude");
    await postJson(`${url}/api/agents/${claude.id}/messages`, {
      prompt: "fill context",
      attachments: [],
      idempotencyKey: "auto-context-turn",
    });
    const before = await waitForIdle(url, project.id, claude.id);
    expect(before.context.percent).toBe(60);
    expect(before.autoCompact.dueAt).toBeGreaterThan(0);
    const after = await waitForAgent(url, project.id, claude.id,
      (agent) => !agent.running && agent.context?.usedTokens === 30_000,
      "automatic compact did not finish");
    expect(after.context.percent).toBe(15);
    expect(calls.filter((call) => call.command === "fake-claude")).toHaveLength(2);
  });

  it("persists only the registry and hydrates readable native history after restart", async () => {
    const setupOne = await setup();
    const project = await createProject(setupOne.url, setupOne.workspace);
    const agent = await createAgent(setupOne.url, project, "claude");
    await postJson(`${setupOne.url}/api/agents/${agent.id}/messages`, {
      prompt: "persist me",
      attachments: [],
      idempotencyKey: "persist-turn",
    });
    await waitForIdle(setupOne.url, project.id, agent.id);
    await setupOne.app.close();

    const nativeDir = claudeProjectDir(setupOne.workspace, setupOne.homeDir);
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(nativeDir, `${CLAUDE_SESSION}.jsonl`), [
      JSON.stringify({ type: "user", message: { content: "native question" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "native answer" }],
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 119_990,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
          },
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] },
      }),
      JSON.stringify({
        type: "user",
        message: { content: "This session is being continued from a previous conversation that ran out of context. Internal summary." },
      }),
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "manual", preTokens: 120_000, postTokens: 30_000 },
      }),
      "",
    ].join("\n"));

    expect(statSync(join(setupOne.dataDir, "registry.json")).mode & 0o777).toBe(0o600);
    const appTwo = createWebUi({
      dataDir: setupOne.dataDir,
      homeDir: setupOne.homeDir,
      legacyDataDir: null,
      claudeCommand: "fake-claude",
      codexCommand: "fake-codex",
      spawnProcess: fakeSpawn([]),
    });
    const second = await appTwo.listen({ port: 0 });
    cleanups.push(() => appTwo.close());
    const list = await request(`${second.url}/api/projects`);
    expect(list.body.projects[0].cwd).toBe(setupOne.workspace);
    expect(list.body.projects[0].agents[0].context).toMatchObject({ usedTokens: 30_000, percent: 15 });
    const history = await request(`${second.url}/api/agents/${agent.id}/history`);
    const historyTexts = history.body.events
      .map((event) => event.text || event.message?.content?.[0]?.text)
      .filter(Boolean);
    expect(historyTexts).toEqual(expect.arrayContaining(["native question", "native answer"]));
    expect(historyTexts).not.toContain("No response requested.");
    expect(historyTexts.some((text) => text.includes("Internal summary"))).toBe(false);
    expect(history.body.events.some((event) => event.subtype === "compacted"
      && event.metadata?.post_tokens === 30_000)).toBe(true);
    expect(readFileSync(join(setupOne.dataDir, "registry.json"), "utf8")).not.toContain("native answer");
  });

  it("answers Claude side questions in a non-persistent fork and serves the Suggest-like UI", async () => {
    const { url, workspace, calls } = await setup();
    const project = await createProject(url, workspace);
    const claude = await createAgent(url, project, "claude");
    const codex = await createAgent(url, project, "codex");
    await postJson(`${url}/api/agents/${claude.id}/messages`, {
      prompt: "establish context",
      attachments: [],
      idempotencyKey: "context-turn",
    });
    await waitForIdle(url, project.id, claude.id);

    const side = await postJson(`${url}/api/agents/${claude.id}/side-questions`, {
      question: "what is the context?",
      idempotencyKey: "side-1",
    });
    expect(side.status).toBe(200);
    expect(side.body.answer).toBe("SIDE_OK: what is the context?");
    const sideCall = calls.at(-1);
    expect(sideCall.args).toContain("--fork-session");
    expect(sideCall.args).toContain("--no-session-persistence");
    expect(sideCall.args).toContain(CLAUDE_SESSION);
    expect(sideCall.args.some((argument) => argument.includes("what is the context?"))).toBe(true);

    const count = calls.length;
    const replay = await postJson(`${url}/api/agents/${claude.id}/side-questions`, {
      question: "what is the context?",
      idempotencyKey: "side-1",
    });
    expect(replay.body.replayed).toBe(true);
    expect(calls).toHaveLength(count);
    expect((await postJson(`${url}/api/agents/${codex.id}/side-questions`, {
      question: "side",
      idempotencyKey: "codex-side",
    })).status).toBe(400);

    const page = await request(url);
    expect(page.status).toBe(200);
    expect(page.body).toContain("project-select");
    expect(page.body).toContain("side-question-button");
    expect(page.body).toContain("agent-effort-select");
    expect(page.body).toContain("context-control");
    expect(page.body).toContain("compact-button");
    expect(page.body).toContain("interrupt-button");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect((await request(`${url}/style.css`)).body).toContain("--canvas: #f2f3ee");
    const app = (await request(`${url}/app.js`)).body;
    expect(app).toContain("/side-questions");
    expect(app).toContain("/compact");
    expect(app).toContain("/interrupt");
    const config = await request(`${url}/api/config`);
    expect(config.body.efforts.claude).toContain("max");
    expect(config.body.efforts.codex).toContain("xhigh");
    expect(config.body.autoCompact).toEqual({ contextPercent: 60, idleMs: 300_000 });
  });

  it("snapshots frontend assets at process start so backend and UI releases stay atomic", async () => {
    const assets = {
      "index.html": "release-a-index",
      "app.js": "release-a-app",
      "style.css": "release-a-style",
    };
    const { url } = await setup({ staticAssets: assets });
    assets["index.html"] = "release-b-index";
    assets["app.js"] = "release-b-app";
    assets["style.css"] = "release-b-style";

    expect((await request(url)).body).toBe("release-a-index");
    expect((await request(`${url}/app.js`)).body).toBe("release-a-app");
    expect((await request(`${url}/style.css`)).body).toBe("release-a-style");
  });
});
