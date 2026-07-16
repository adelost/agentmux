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
import { latestPaneStates } from "../core/events.mjs";
import { claudePermissionDenial, createWebUi, publicToolActivity } from "../spikes/web-ui/server.mjs";

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
          } else if (message.message?.content?.startsWith("/compact")) {
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
          } else if (message.message?.content === "DENY_PERMISSION") {
            emit(
              { type: "system", subtype: "init", session_id: CLAUDE_SESSION },
              {
                type: "result",
                subtype: "success",
                session_id: CLAUDE_SESSION,
                result: "The requested tool was not allowed.",
                permission_denials: [{ tool_name: "Bash", reason: "approval unavailable" }],
              },
            );
            close();
          } else if (message.message?.content === "SHOW_TOOL_ACTIVITY") {
            emit(
              { type: "system", subtype: "init", session_id: CLAUDE_SESSION },
              {
                type: "assistant",
                session_id: CLAUDE_SESSION,
                message: {
                  content: [
                    { type: "text", text: "Checking the workspace." },
                    {
                      type: "tool_use",
                      id: "claude-tool-1",
                      name: "Bash",
                      input: { command: "curl -H 'Authorization: Bearer claude-super-secret-value' https://example.test" },
                    },
                  ],
                },
              },
              {
                type: "user",
                session_id: CLAUDE_SESSION,
                message: {
                  content: [{
                    type: "tool_result",
                    tool_use_id: "claude-tool-1",
                    content: "token=claude-result-secret all checks passed",
                  }],
                },
              },
              {
                type: "assistant",
                session_id: CLAUDE_SESSION,
                message: { content: [{ type: "text", text: "Claude tools complete." }] },
              },
              { type: "result", subtype: "success", session_id: CLAUDE_SESSION, duration_ms: 12 },
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
          if (prompt === "SHOW_TOOL_ACTIVITY") queueMicrotask(() => emit(
            { method: "turn/started", params: { threadId: CODEX_SESSION, turn: { id: "codex-turn" } } },
            {
              method: "item/started",
              params: {
                threadId: CODEX_SESSION,
                turnId: "codex-turn",
                item: {
                  id: "codex-tool-1",
                  type: "commandExecution",
                  command: "env API_TOKEN=codex-super-secret-value npm test",
                },
              },
            },
            {
              method: "item/completed",
              params: {
                threadId: CODEX_SESSION,
                turnId: "codex-turn",
                item: {
                  id: "codex-tool-1",
                  type: "commandExecution",
                  command: "env API_TOKEN=codex-super-secret-value npm test",
                  aggregatedOutput: "password=codex-result-secret 42 tests passed",
                  status: "completed",
                  exitCode: 0,
                  durationMs: 37,
                },
              },
            },
            {
              method: "item/started",
              params: {
                threadId: CODEX_SESSION,
                turnId: "codex-turn",
                item: {
                  id: "codex-tool-2",
                  type: "fileChange",
                  changes: [{ path: "spikes/web-ui/app.js", diff: "+codex-patch-secret" }],
                },
              },
            },
            {
              method: "item/completed",
              params: {
                threadId: CODEX_SESSION,
                turnId: "codex-turn",
                item: {
                  id: "codex-tool-2",
                  type: "fileChange",
                  changes: [{ path: "spikes/web-ui/app.js", diff: "+codex-patch-secret" }],
                  status: "completed",
                },
              },
            },
            {
              method: "item/started",
              params: {
                threadId: CODEX_SESSION,
                turnId: "codex-turn",
                item: {
                  id: "codex-tool-3",
                  type: "mcpToolCall",
                  tool: "browser.open",
                  arguments: { url: "https://example.test", apiKey: "codex-mcp-secret" },
                },
              },
            },
            {
              method: "item/completed",
              params: {
                threadId: CODEX_SESSION,
                turnId: "codex-turn",
                item: {
                  id: "codex-tool-3",
                  type: "mcpToolCall",
                  tool: "browser.open",
                  arguments: { url: "https://example.test", apiKey: "codex-mcp-secret" },
                  status: "failed",
                  error: { message: "authorization=codex-mcp-result-secret request failed" },
                },
              },
            },
            { method: "item/completed", params: { threadId: CODEX_SESSION, turnId: "codex-turn", item: { type: "agentMessage", text: "Codex tools complete." } } },
            { method: "turn/completed", params: { threadId: CODEX_SESSION, turn: { id: "codex-turn", status: "completed", durationMs: 40 } } },
          ));
          else if (prompt !== "WAIT_FOR_INTERRUPT") queueMicrotask(() => emit(
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
    appendEventImpl: () => {},
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

async function createAgent(url, project, engine, key = `${engine}-agent-key`, extra = {}) {
  const response = await postJson(`${url}/api/projects/${project.id}/agents`, {
    name: engine === "claude" ? "Claude agent" : "Codex agent",
    engine,
    model: engine === "claude" ? "claude-opus-4-8" : "gpt-5.6-sol",
    idempotencyKey: key,
    ...extra,
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
  it("publishes bounded tool details while redacting credentials and patch bodies", () => {
    const patch = publicToolActivity({
      toolId: "patch-1",
      name: "apply_patch",
      phase: "completed",
      input: {
        path: "spikes/web-ui/app.js",
        patch: "*** Begin Patch\n+const password = 'must-not-leak';\n*** End Patch",
      },
      result: `Authorization: Bearer result-secret-token ${"x".repeat(2_000)}`,
      durationMs: 14.4,
    });
    expect(patch).toMatchObject({
      toolId: "patch-1",
      name: "apply_patch",
      phase: "completed",
      summary: "spikes/web-ui/app.js",
      durationMs: 14,
    });
    expect(JSON.stringify(patch)).not.toContain("must-not-leak");
    expect(JSON.stringify(patch)).not.toContain("result-secret-token");
    expect(patch.result.length).toBeLessThanOrEqual(1_200);

    const mcp = publicToolActivity({
      toolId: "mcp-1",
      name: "mcp_tool",
      input: { query: "visible", api_key: "hidden-value", nested: { session_token: "hidden-too" } },
    });
    expect(mcp.summary).toContain("visible");
    expect(mcp.summary).toContain("[redacted]");
    expect(mcp.summary).not.toContain("hidden-value");
    expect(mcp.summary).not.toContain("hidden-too");
  });

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

  it("keeps mutable model and effort settings out of the agent identity receipt", async () => {
    const { url, workspace } = await setup();
    const project = await createProject(url, workspace);
    const agent = await createAgent(url, project, "claude", "stable-agent-key", {
      effort: "medium",
      address: { session: "skybar-canary", pane: 0 },
      permissionMode: "automation",
    });

    const updated = await request(`${url}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        effort: "high",
        idempotencyKey: "stable-agent-settings",
      }),
    });
    expect(updated.status).toBe(200);

    const replay = await postJson(`${url}/api/projects/${project.id}/agents`, {
      name: "Claude agent",
      engine: "claude",
      model: "claude-sonnet-4-5",
      effort: "high",
      address: { session: "skybar-canary", pane: 0 },
      permissionMode: "automation",
      idempotencyKey: "stable-agent-key",
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      id: agent.id,
      model: "claude-sonnet-4-5",
      effort: "high",
      replayed: true,
    });

    const identityConflict = await postJson(`${url}/api/projects/${project.id}/agents`, {
      name: "Claude agent",
      engine: "claude",
      address: { session: "skybar-canary", pane: 1 },
      permissionMode: "automation",
      idempotencyKey: "stable-agent-key",
    });
    expect(identityConflict.status).toBe(409);
    expect(identityConflict.body.error).toBe("idempotency-key-conflict");
  });

  it("binds an existing idle native session to one automation address without replacing it", async () => {
    const { url, workspace } = await setup();
    const project = await createProject(url, workspace);
    const agent = await createAgent(url, project, "codex", "adoptable-agent");
    await postJson(`${url}/api/agents/${agent.id}/messages`, {
      prompt: "establish exact session",
      attachments: [],
      idempotencyKey: "adoptable-session-turn",
    });
    const idle = await waitForIdle(url, project.id, agent.id);
    const sessionId = idle.sessionId;

    const adopted = await request(`${url}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: { session: "code", pane: 0 },
        permissionMode: "automation",
        idempotencyKey: "adopt-existing-session",
      }),
    });
    expect(adopted.status).toBe(200);
    expect(adopted.body).toMatchObject({
      sessionId,
      address: { session: "code", pane: 0 },
      permissionMode: "automation",
    });

    const rebound = await request(`${url}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: { session: "other", pane: 0 },
        idempotencyKey: "rebind-existing-session",
      }),
    });
    expect(rebound.status).toBe(409);
    expect(rebound.body.error).toBe("agent-address-already-bound");
  });

  it("imports exact idle tmux sessions without launching a second writer", async () => {
    const { url, workspace, homeDir, calls } = await setup();
    const project = await createProject(url, workspace);
    const claudePane = join(workspace, ".agents", "0");
    const codexPane = join(workspace, ".agents", "1");
    mkdirSync(claudePane, { recursive: true });
    mkdirSync(codexPane, { recursive: true });
    const claudeStore = claudeProjectDir(claudePane, homeDir);
    mkdirSync(claudeStore, { recursive: true });
    writeFileSync(join(claudeStore, `${CLAUDE_SESSION}.jsonl`), "{}\n");
    const codexStore = join(homeDir, ".codex", "sessions", "2026", "07", "16");
    mkdirSync(codexStore, { recursive: true });
    writeFileSync(join(codexStore, `rollout-${CODEX_SESSION}.jsonl`), `${JSON.stringify({
      type: "session_meta",
      payload: { id: CODEX_SESSION, cwd: codexPane },
    })}\n`);

    // Override points at the exact isolated test store. Nothing is spawned by
    // import; the old tmux process can remain the sole writer until cutover.
    const importClaude = await postJson(`${url}/api/projects/${project.id}/session-imports`, {
      name: "claw:0",
      engine: "claude",
      model: "claude-opus-4-8",
      effort: "high",
      address: { session: "claw", pane: 0 },
      permissionMode: "automation",
      sessionId: CLAUDE_SESSION,
      sourceCwd: claudePane,
      idempotencyKey: "import-claw-0",
    });
    expect(importClaude.status).toBe(201);
    expect(importClaude.body).toMatchObject({
      sessionId: CLAUDE_SESSION,
      running: false,
      address: { session: "claw", pane: 0 },
    });
    expect(calls).toHaveLength(0);

    const replay = await postJson(`${url}/api/projects/${project.id}/session-imports`, {
      name: "claw:0",
      engine: "claude",
      model: "claude-opus-4-8",
      effort: "high",
      address: { session: "claw", pane: 0 },
      permissionMode: "automation",
      sessionId: CLAUDE_SESSION,
      sourceCwd: claudePane,
      idempotencyKey: "import-claw-0",
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ id: importClaude.body.id, replayed: true });

    const importCodex = await postJson(`${url}/api/projects/${project.id}/session-imports`, {
      name: "claw:1",
      engine: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      address: { session: "claw", pane: 1 },
      permissionMode: "automation",
      sessionId: CODEX_SESSION,
      sourceCwd: codexPane,
      idempotencyKey: "import-claw-1",
    });
    expect(importCodex.status).toBe(201);
    expect(importCodex.body).toMatchObject({
      sessionId: CODEX_SESSION,
      running: false,
      address: { session: "claw", pane: 1 },
    });
    expect(calls).toHaveLength(0);

    const wrongCwd = await postJson(`${url}/api/projects/${project.id}/session-imports`, {
      name: "claw:1",
      engine: "codex",
      address: { session: "claw", pane: 1 },
      permissionMode: "automation",
      sessionId: CODEX_SESSION,
      sourceCwd: workspace,
      idempotencyKey: "import-claw-1-wrong",
    });
    expect(wrongCwd.status).toBe(409);
    expect(wrongCwd.body.error).toBe("session-source-cwd-mismatch");

    await postJson(`${url}/api/agents/${importClaude.body.id}/messages`, {
      prompt: "continue imported session",
      attachments: [],
      idempotencyKey: "imported-first-turn",
    });
    await waitForIdle(url, project.id, importClaude.body.id);
    expect(calls[0].args).toContain("--resume");
    expect(calls[0].args).toContain(CLAUDE_SESSION);

    await postJson(`${url}/api/agents/${importCodex.body.id}/messages`, {
      prompt: "continue imported codex session",
      attachments: [],
      idempotencyKey: "imported-codex-first-turn",
    });
    await waitForIdle(url, project.id, importCodex.body.id);
    expect(calls.at(-1).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "thread/resume",
        params: expect.objectContaining({ threadId: CODEX_SESSION }),
      }),
    ]));
  });

  it("runs Claude and Codex in the project, resumes sessions and de-duplicates messages", async () => {
    const { url, workspace, calls } = await setup();
    const project = await createProject(url, workspace);
    const claude = await createAgent(url, project, "claude");
    const codex = await createAgent(url, project, "codex");

    const upload = await request(`${url}/api/projects/${project.id}/uploads?name=note.txt`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-idempotency-key": "note-upload-1",
      },
      body: "important file",
    });
    expect(upload.status).toBe(201);
    const uploadReplay = await request(`${url}/api/projects/${project.id}/uploads?name=note.txt`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-idempotency-key": "note-upload-1",
      },
      body: "important file",
    });
    expect(uploadReplay.status).toBe(200);
    expect(uploadReplay.body).toMatchObject({ path: upload.body.path, replayed: true });

    const pastedImage = await request(`${url}/api/projects/${project.id}/uploads?name=pasted-image-1.png`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-idempotency-key": "pasted-image-upload-1",
      },
      body: Buffer.from("89504e470d0a1a0a", "hex"),
    });
    expect(pastedImage.status).toBe(201);
    expect(pastedImage.body).toMatchObject({ name: "pasted-image-1.png", image: true });

    const first = await postJson(`${url}/api/agents/${claude.id}/messages`, {
      prompt: "hello claude",
      attachments: [
        { path: upload.body.path, name: "note.txt" },
        { path: pastedImage.body.path, name: pastedImage.body.name },
      ],
      idempotencyKey: "claude-turn-1",
    });
    expect(first.status).toBe(202);
    await waitForIdle(url, project.id, claude.id);
    expect(calls[0].command).toBe("fake-claude");
    expect(calls[0].options.cwd).toBe(workspace);
    expect(calls[0].args).toContain("acceptEdits");
    expect(calls[0].args).toContain("--effort");
    expect(calls[0].messages[0].message.content).toContain(upload.body.path);
    expect(calls[0].messages[0].message.content).toContain(pastedImage.body.path);

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

  it("accepts multiple messages during a turn and drains them in durable FIFO order", async () => {
    const { url, workspace, calls } = await setup();
    const project = await createProject(url, workspace);
    const claude = await createAgent(url, project, "claude");
    const first = await postJson(`${url}/api/agents/${claude.id}/messages`, {
      prompt: "WAIT_FOR_INTERRUPT",
      attachments: [],
      idempotencyKey: "fifo-first",
    });
    expect(first.status).toBe(202);
    await waitForAgent(url, project.id, claude.id, (agent) => agent.running, "first turn never started");

    const second = await postJson(`${url}/api/agents/${claude.id}/messages`, {
      prompt: "FIFO_SECOND",
      attachments: [],
      idempotencyKey: "fifo-second",
    });
    const third = await postJson(`${url}/api/agents/${claude.id}/messages`, {
      prompt: "FIFO_THIRD",
      attachments: [],
      idempotencyKey: "fifo-third",
    });
    expect(second).toMatchObject({ status: 202, body: { running: true, queuedMessages: 1 } });
    expect(third).toMatchObject({ status: 202, body: { running: true, queuedMessages: 2 } });
    const replay = await postJson(`${url}/api/agents/${claude.id}/messages`, {
      prompt: "FIFO_SECOND",
      attachments: [],
      idempotencyKey: "fifo-second",
    });
    expect(replay).toMatchObject({ status: 200, body: { replayed: true, queuedMessages: 2 } });

    let interrupt;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      interrupt = await postJson(`${url}/api/agents/${claude.id}/interrupt`, {
        idempotencyKey: "fifo-interrupt-first",
      });
      if (interrupt.status === 202) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect(interrupt.status).toBe(202);
    const idle = await waitForAgent(url, project.id, claude.id,
      (agent) => !agent.running && agent.queuedMessages === 0,
      "queued turns did not drain");
    expect(idle.queuedMessages).toBe(0);
    expect(calls.filter((call) => call.command === "fake-claude")
      .map((call) => call.messages[0]?.message?.content)).toEqual([
      "WAIT_FOR_INTERRUPT", "FIFO_SECOND", "FIFO_THIRD",
    ]);
    const history = await request(`${url}/api/agents/${claude.id}/history`);
    expect(history.body.operations.map((operation) => operation.operationKey)).toEqual(expect.arrayContaining([
      "fifo-first", "fifo-second", "fifo-third",
    ]));
    expect(history.body.operations.every((operation) => operation.code === 0)).toBe(true);
  });

  it("resumes accepted-but-not-started FIFO messages after a runtime restart", async () => {
    const firstRuntime = await setup();
    const project = await createProject(firstRuntime.url, firstRuntime.workspace);
    const claude = await createAgent(firstRuntime.url, project, "claude");
    await postJson(`${firstRuntime.url}/api/agents/${claude.id}/messages`, {
      prompt: "WAIT_FOR_INTERRUPT",
      attachments: [],
      idempotencyKey: "restart-active",
    });
    await waitForAgent(firstRuntime.url, project.id, claude.id, (agent) => agent.running);
    await postJson(`${firstRuntime.url}/api/agents/${claude.id}/messages`, {
      prompt: "RUN_AFTER_RESTART",
      attachments: [],
      idempotencyKey: "restart-queued",
    });
    await firstRuntime.app.close();

    const calls = [];
    const secondApp = createWebUi({
      dataDir: firstRuntime.dataDir,
      homeDir: firstRuntime.homeDir,
      legacyDataDir: null,
      claudeCommand: "fake-claude",
      codexCommand: "fake-codex",
      spawnProcess: fakeSpawn(calls),
      appendEventImpl: () => {},
    });
    const { url } = await secondApp.listen({ port: 0 });
    cleanups.push(async () => secondApp.close());
    const idle = await waitForAgent(url, project.id, claude.id,
      (agent) => !agent.running && agent.queuedMessages === 0,
      "persisted queue did not resume after restart");
    expect(idle.queuedMessages).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].messages[0].message.content).toBe("RUN_AFTER_RESTART");
    const history = await request(`${url}/api/agents/${claude.id}/history`);
    expect(history.body.operations.find((operation) => operation.operationKey === "restart-queued"))
      .toMatchObject({ code: 0 });
  });

  it("fails a submitted crash-window message loudly instead of replaying it", async () => {
    const firstRuntime = await setup();
    const project = await createProject(firstRuntime.url, firstRuntime.workspace);
    const claude = await createAgent(firstRuntime.url, project, "claude");
    await firstRuntime.app.close();
    const registryPath = join(firstRuntime.dataDir, "registry.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    registry.receipts.messages.uncertain = {
      id: claude.id,
      hash: "uncertain-hash",
      acceptedAt: Date.now() - 1_000,
    };
    registry.queuedMessages = {
      uncertain: {
        id: claude.id,
        prompt: "MAY_ALREADY_HAVE_RUN",
        attachments: [],
        acceptedAt: Date.now() - 1_000,
        startedAt: Date.now() - 900,
      },
    };
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    const calls = [];
    const secondApp = createWebUi({
      dataDir: firstRuntime.dataDir,
      homeDir: firstRuntime.homeDir,
      legacyDataDir: null,
      spawnProcess: fakeSpawn(calls),
      appendEventImpl: () => {},
    });
    const { url } = await secondApp.listen({ port: 0 });
    cleanups.push(async () => secondApp.close());
    const history = await request(`${url}/api/agents/${claude.id}/history`);
    expect(history.body.agent).toMatchObject({ running: false, queuedMessages: 0 });
    expect(history.body.operations.find((operation) => operation.operationKey === "uncertain"))
      .toMatchObject({ code: -1, error: expect.stringContaining("outcome is uncertain") });
    expect(calls).toHaveLength(0);
  });

  it("normalizes live Claude and Codex tools into one redacted activity contract", async () => {
    const { url, workspace } = await setup();
    const project = await createProject(url, workspace);
    const claude = await createAgent(url, project, "claude", "tool-claude");
    const codex = await createAgent(url, project, "codex", "tool-codex");

    for (const [agent, key] of [[claude, "claude"], [codex, "codex"]]) {
      expect((await postJson(`${url}/api/agents/${agent.id}/messages`, {
        prompt: "SHOW_TOOL_ACTIVITY",
        attachments: [],
        idempotencyKey: `${key}-tool-turn`,
      })).status).toBe(202);
      await waitForIdle(url, project.id, agent.id);
    }

    const claudeEvents = (await request(`${url}/api/agents/${claude.id}/history`)).body.events;
    const claudeTools = claudeEvents.filter((event) => event.subtype === "tool");
    expect(claudeTools).toEqual([
      expect.objectContaining({ toolId: "claude-tool-1", name: "Bash", phase: "started" }),
      expect.objectContaining({ toolId: "claude-tool-1", name: "Bash", phase: "completed" }),
    ]);
    expect(claudeTools[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(claudeEvents.filter((event) => event.type === "assistant")
      .flatMap((event) => event.message?.content ?? [])
      .some((block) => block.type === "tool_use")).toBe(false);

    const codexEvents = (await request(`${url}/api/agents/${codex.id}/history`)).body.events;
    const codexTools = codexEvents.filter((event) => event.subtype === "tool");
    expect(codexTools.map((event) => [event.toolId, event.name, event.phase])).toEqual([
      ["codex-tool-1", "exec_command", "started"],
      ["codex-tool-1", "exec_command", "completed"],
      ["codex-tool-2", "apply_patch", "started"],
      ["codex-tool-2", "apply_patch", "completed"],
      ["codex-tool-3", "browser.open", "started"],
      ["codex-tool-3", "browser.open", "failed"],
    ]);
    expect(codexTools.find((event) => event.toolId === "codex-tool-2")?.summary)
      .toContain("spikes/web-ui/app.js");

    const publicEvents = JSON.stringify({ claudeEvents, codexEvents });
    for (const secret of [
      "claude-super-secret-value",
      "claude-result-secret",
      "codex-super-secret-value",
      "codex-result-secret",
      "codex-patch-secret",
      "codex-mcp-secret",
      "codex-mcp-result-secret",
    ]) expect(publicEvents).not.toContain(secret);
  });

  it("journals prompts before engine completion and filters one ledger by all, project or agent", async () => {
    const { url, workspace, dataDir } = await setup();
    const project = await createProject(url, workspace);
    const claude = await createAgent(url, project, "claude");
    const blockedPrompt = "WAIT_FOR_INTERRUPT";

    expect((await postJson(`${url}/api/agents/${claude.id}/messages`, {
      prompt: blockedPrompt,
      attachments: [],
      idempotencyKey: "journal-running-turn",
      source: "web",
    })).status).toBe(202);

    const persisted = JSON.parse(readFileSync(join(dataDir, "registry.json"), "utf8"))
      .receipts.messages["journal-running-turn"];
    expect(persisted).toMatchObject({
      projectId: project.id,
      projectName: "Testprojekt",
      agentName: "Claude agent",
      source: "web",
      promptPreview: blockedPrompt,
      promptPreviewTruncated: false,
    });

    const whileRunning = await request(`${url}/api/prompts?scope=all`);
    expect(whileRunning.status).toBe(200);
    expect(whileRunning.body.prompts).toEqual([expect.objectContaining({
      operationKey: "journal-running-turn",
      projectId: project.id,
      agentId: claude.id,
      source: "web",
      deliveryStatus: "accepted",
      turnStatus: "running",
      preview: blockedPrompt,
      previewTruncated: false,
    })]);

    expect((await postJson(`${url}/api/agents/${claude.id}/messages`, {
      prompt: blockedPrompt,
      attachments: [],
      idempotencyKey: "journal-running-turn",
      source: "web",
    })).body.replayed).toBe(true);
    expect((await request(`${url}/api/prompts?scope=all`)).body.prompts).toHaveLength(1);

    expect((await postJson(`${url}/api/agents/${claude.id}/interrupt`, {
      idempotencyKey: "journal-interrupt",
    })).status).toBe(202);
    await waitForAgent(url, project.id, claude.id, (agent) => !agent.running);

    const secondProject = (await postJson(`${url}/api/projects`, {
      name: "Andra projektet",
      cwd: workspace,
      idempotencyKey: "journal-project-two",
    })).body;
    const codex = await createAgent(url, secondProject, "codex", "journal-codex");
    const longPrompt = `  Fråga från Discord\n${"x".repeat(520)}  `;
    expect((await postJson(`${url}/api/agents/${codex.id}/messages`, {
      prompt: longPrompt,
      attachments: [],
      idempotencyKey: "delivery:journal-discord",
      source: "discord",
    })).status).toBe(202);
    await waitForIdle(url, secondProject.id, codex.id);

    const all = await request(`${url}/api/prompts?scope=all&limit=2`);
    expect(all.body.prompts.map((entry) => entry.operationKey)).toEqual([
      "delivery:journal-discord",
      "journal-running-turn",
    ]);
    expect(all.body.prompts[0]).toMatchObject({
      source: "discord",
      turnStatus: "completed",
      previewTruncated: true,
    });
    expect(all.body.prompts[0].preview).toHaveLength(500);
    expect(all.body.prompts[0].preview).toMatch(/^Fråga från Discord x/u);

    const projectOnly = await request(`${url}/api/prompts?scope=project&projectId=${project.id}`);
    expect(projectOnly.body.prompts.map((entry) => entry.operationKey)).toEqual(["journal-running-turn"]);
    const agentOnly = await request(`${url}/api/prompts?scope=agent&agentId=${codex.id}`);
    expect(agentOnly.body.prompts.map((entry) => entry.operationKey)).toEqual(["delivery:journal-discord"]);
    expect((await request(`${url}/api/prompts?scope=project`)).status).toBe(400);
    expect((await request(`${url}/api/prompts?scope=unknown`)).status).toBe(400);
    expect((await request(`${url}/api/prompts?scope=all&limit=501`)).status).toBe(400);

    expect((await request(`${url}/api/agents/${claude.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await request(`${url}/api/projects/${project.id}`, { method: "DELETE" })).status).toBe(200);
    const afterDelete = await request(`${url}/api/prompts?scope=agent&agentId=${claude.id}`);
    expect(afterDelete.body.prompts[0]).toMatchObject({
      projectId: project.id,
      projectName: "Testprojekt",
      agentName: "Claude agent",
      turnStatus: "interrupted",
    });
  });

  it("pins and unpins conversations idempotently and preserves pins across restart", async () => {
    const { url, workspace, dataDir, homeDir, app } = await setup();
    const project = await createProject(url, workspace);
    const agent = await createAgent(url, project, "claude");

    const pinBody = { pinned: true, idempotencyKey: "pin-conversation-once" };
    const pinned = await postJson(`${url}/api/agents/${agent.id}/pin`, pinBody);
    expect(pinned.status).toBe(200);
    expect(pinned.body.pinnedAt).toEqual(expect.any(Number));
    const pinnedAt = pinned.body.pinnedAt;

    const replay = await postJson(`${url}/api/agents/${agent.id}/pin`, pinBody);
    expect(replay.body).toMatchObject({ pinnedAt, replayed: true });
    const conflict = await postJson(`${url}/api/agents/${agent.id}/pin`, {
      pinned: false,
      idempotencyKey: "pin-conversation-once",
    });
    expect(conflict.status).toBe(409);
    expect((await postJson(`${url}/api/agents/${agent.id}/pin`, {
      pinned: "yes",
      idempotencyKey: "invalid-pin",
    })).status).toBe(400);

    await app.close();
    const restarted = createWebUi({
      dataDir,
      homeDir,
      legacyDataDir: null,
      claudeCommand: "fake-claude",
      codexCommand: "fake-codex",
      spawnProcess: fakeSpawn([]),
      appendEventImpl: () => {},
    });
    const second = await restarted.listen({ port: 0 });
    cleanups.push(() => restarted.close());
    const restored = await request(`${second.url}/api/projects`);
    expect(restored.body.projects[0].agents[0].pinnedAt).toBe(pinnedAt);

    const unpinned = await postJson(`${second.url}/api/agents/${agent.id}/pin`, {
      pinned: false,
      idempotencyKey: "unpin-conversation",
    });
    expect(unpinned.body.pinnedAt).toBeNull();
    expect((await request(`${second.url}/api/projects`)).body.projects[0].agents[0].pinnedAt).toBeNull();
  });

  it("runs bridge-owned agents with stable identity and explicit automation permissions", async () => {
    const { url, workspace, calls } = await setup();
    const project = await createProject(url, workspace);
    const claude = await createAgent(url, project, "claude", "automation-claude", {
      address: { session: "skybar-canary", pane: 0 },
      permissionMode: "automation",
    });
    const codex = await createAgent(url, project, "codex", "automation-codex", {
      address: { session: "skybar-canary", pane: 1 },
      permissionMode: "automation",
    });
    expect(claude.address).toEqual({ session: "skybar-canary", pane: 0 });
    expect(codex.permissionMode).toBe("automation");

    await postJson(`${url}/api/agents/${claude.id}/messages`, {
      prompt: "automation claude",
      attachments: [],
      idempotencyKey: "automation-claude-turn",
    });
    await waitForIdle(url, project.id, claude.id);
    const claudeCall = calls.find((call) => call.command === "fake-claude");
    expect(claudeCall.args).toContain("--dangerously-skip-permissions");
    expect(claudeCall.args).not.toContain("acceptEdits");
    expect(claudeCall.options.env).toMatchObject({
      AMUX_NATIVE_RUNTIME: "1",
      AMUX_AGENT_NAME: "skybar-canary",
      AMUX_PANE: "0",
      AMUX_AGENT_ID: claude.id,
    });

    await postJson(`${url}/api/agents/${codex.id}/messages`, {
      prompt: "automation codex",
      attachments: [],
      idempotencyKey: "automation-codex-turn",
    });
    await waitForIdle(url, project.id, codex.id);
    const codexCall = calls.find((call) => call.command === "fake-codex");
    expect(codexCall.options.env).toMatchObject({
      AMUX_AGENT_NAME: "skybar-canary",
      AMUX_PANE: "1",
    });
    expect(codexCall.messages.find((message) => message.method === "thread/start")?.params)
      .toMatchObject({
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      });
    expect(codexCall.messages.find((message) => message.method === "turn/start")?.params)
      .toMatchObject({
        sandboxPolicy: { type: "dangerFullAccess" },
        approvalPolicy: "never",
      });
  });

  it("surfaces Claude permission denial in the UI stream and fleet event ledger", async () => {
    const fleetEvents = [];
    const { url, root, workspace, dataDir, homeDir, app, calls } = await setup({
      appendEventImpl: (event) => fleetEvents.push(structuredClone(event)),
    });
    const project = await createProject(url, workspace);
    const claude = await createAgent(url, project, "claude", "permission-agent", {
      address: { session: "skybar-canary", pane: 0 },
    });

    expect((await postJson(`${url}/api/agents/${claude.id}/messages`, {
      prompt: "DENY_PERMISSION",
      attachments: [],
      idempotencyKey: "permission-denied-turn",
    })).status).toBe(202);
    await waitForIdle(url, project.id, claude.id);

    const history = await request(`${url}/api/agents/${claude.id}/history`);
    const denial = history.body.events.find((event) => event.subtype === "permission-denied");
    const done = history.body.events.find((event) => event.subtype === "turn-done");
    expect(denial).toMatchObject({
      message: expect.stringContaining("Bash"),
      denial: { count: 1, detail: "Bash" },
    });
    expect(done).toMatchObject({ code: 1, permissionDenied: true });
    expect(history.body.operations).toEqual([expect.objectContaining({
      operationKey: "permission-denied-turn",
      code: 1,
      sessionId: CLAUDE_SESSION,
      permissionDenied: true,
      denialDetail: "Bash",
    })]);
    expect(claudePermissionDenial({
      type: "result",
      permission_denials: [{ tool_name: "Bash" }],
    })).toEqual({ count: 1, detail: "Bash" });
    expect(calls[0].args).toContain("acceptEdits");
    expect(calls[0].args).not.toContain("--dangerously-skip-permissions");
    expect(fleetEvents.map((event) => event.event)).toEqual([
      "prompt", "session_start", "prompt", "stop", "notification",
    ]);
    expect(fleetEvents.at(-1)).toMatchObject({
      session: "skybar-canary",
      pane: 0,
      event: "notification",
      needsYou: true,
      detail: expect.stringContaining("permission denied"),
    });
    const stateAt = (count) => {
      const path = join(root, `fleet-events-${count}.jsonl`);
      writeFileSync(path, `${fleetEvents.slice(0, count).map(JSON.stringify).join("\n")}\n`);
      return latestPaneStates({ path, now: Date.now() }).get("skybar-canary:0")?.state;
    };
    expect(stateAt(1)).toBe("working");
    expect(stateAt(4)).toBe("idle");
    expect(stateAt(5)).toBe("needs_you");

    await app.close();
    const nativeDir = claudeProjectDir(workspace, homeDir);
    mkdirSync(nativeDir, { recursive: true });
    const registryPath = join(dataDir, "registry.json");
    const receipt = JSON.parse(readFileSync(registryPath, "utf8"))
      .receipts.messages["permission-denied-turn"];
    writeFileSync(join(nativeDir, `${CLAUDE_SESSION}.jsonl`), `${JSON.stringify({
      type: "user",
      timestamp: new Date(receipt.acceptedAt).toISOString(),
      message: { content: "DENY_PERMISSION" },
    })}\n`);
    const restarted = createWebUi({
      dataDir,
      homeDir,
      legacyDataDir: null,
      spawnProcess: fakeSpawn([]),
      appendEventImpl: () => {},
    });
    const second = await restarted.listen({ port: 0 });
    cleanups.push(() => restarted.close());
    const restored = await request(`${second.url}/api/agents/${claude.id}/history`);
    expect(restored.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subtype: "permission-denied",
        historical: true,
        operationKey: "permission-denied-turn",
      }),
      expect.objectContaining({
        subtype: "turn-done",
        code: 1,
        permissionDenied: true,
        operationKey: "permission-denied-turn",
      }),
    ]));
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
    const changeModel = await request(`${url}/api/agents/${claude.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", idempotencyKey: "claude-model-sonnet" }),
    });
    expect(changeModel.body).toMatchObject({ model: "claude-sonnet-4-5", effort: "high" });

    await postJson(`${url}/api/agents/${claude.id}/messages`, {
      prompt: "effort claude",
      attachments: [],
      idempotencyKey: "effort-claude-turn",
    });
    await waitForIdle(url, project.id, claude.id);
    const claudeCall = calls.find((call) => call.command === "fake-claude" && !call.args.includes("--fork-session"));
    expect(claudeCall.args.slice(claudeCall.args.indexOf("--effort"), claudeCall.args.indexOf("--effort") + 2))
      .toEqual(["--effort", "high"]);
    expect(claudeCall.args.slice(claudeCall.args.indexOf("--model"), claudeCall.args.indexOf("--model") + 2))
      .toEqual(["--model", "claude-sonnet-4-5"]);

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
    const { url, workspace, calls } = await setup();
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
        ...(key === "claude" ? { focus: "preserve active ticket and gates" } : {}),
      });
      expect(compact.status).toBe(202);
      const after = await waitForAgent(url, project.id, agent.id,
        (item) => !item.running && item.context?.usedTokens === 30_000,
        `${key} did not compact`);
      expect(after.context.percent).toBe(15);
      if (key === "claude") {
        const compactCall = calls.filter((call) => call.command === "fake-claude").at(-1);
        expect(compactCall.messages[0].message.content)
          .toBe("/compact preserve active ticket and gates");
      }
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

    // Simulate a bounded engine-history tail containing an engine-normalized
    // form of the later of two prompts. Its hash no longer round-trips, so
    // same-session timestamp proximity must restore the later stable operation
    // key instead of emitting a second history-hash identity after restart.
    const registryPath = join(setupOne.dataDir, "registry.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    registry.receipts.agentCreates["claude-agent-key"].hash = "legacy-mutable-fingerprint";
    const originalReceipt = registry.receipts.messages["persist-turn"];
    originalReceipt.acceptedAt = Date.parse("2026-07-14T09:00:00.000Z");
    registry.receipts.messages["persist-turn-newer"] = {
      ...originalReceipt,
      acceptedAt: Date.parse("2026-07-14T10:00:00.000Z"),
    };
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    const nativeDir = claudeProjectDir(setupOne.workspace, setupOne.homeDir);
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(nativeDir, `${CLAUDE_SESSION}.jsonl`), [
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-14T10:00:00.000Z",
        message: { content: "persist me (engine-normalized)" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-14T10:00:01.000Z",
        message: {
          model: "claude-opus-4-8",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "persisted answer" }],
        },
      }),
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
    const migratedAgentReplay = await postJson(`${second.url}/api/projects/${project.id}/agents`, {
      name: "Claude agent",
      engine: "claude",
      model: "claude-sonnet-4-5",
      effort: "high",
      idempotencyKey: "claude-agent-key",
    });
    expect(migratedAgentReplay.status).toBe(200);
    expect(migratedAgentReplay.body).toMatchObject({ id: agent.id, replayed: true });
    const migratedRegistry = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(migratedRegistry.receipts.agentCreates["claude-agent-key"].hash)
      .not.toBe("legacy-mutable-fingerprint");
    const list = await request(`${second.url}/api/projects`);
    expect(list.body.projects[0].cwd).toBe(setupOne.workspace);
    expect(list.body.projects[0].agents[0].context).toMatchObject({ usedTokens: 30_000, percent: 15 });
    const promptJournal = await request(`${second.url}/api/prompts?scope=agent&agentId=${agent.id}`);
    expect(promptJournal.body.prompts.map((entry) => entry.operationKey)).toEqual([
      "persist-turn-newer",
      "persist-turn",
    ]);
    expect(promptJournal.body.prompts.every((entry) => entry.preview === "persist me")).toBe(true);
    const history = await request(`${second.url}/api/agents/${agent.id}/history`);
    const historyTexts = history.body.events
      .map((event) => event.text || event.message?.content?.[0]?.text)
      .filter(Boolean);
    expect(historyTexts).toEqual(expect.arrayContaining(["native question", "native answer"]));
    expect(historyTexts).not.toContain("No response requested.");
    expect(historyTexts.some((text) => text.includes("Internal summary"))).toBe(false);
    expect(history.body.events.some((event) => event.subtype === "compacted"
      && event.metadata?.post_tokens === 30_000)).toBe(true);
    expect(history.body.events.some((event) => event.subtype === "turn-done"
      && event.operationKey === "persist-turn-newer")).toBe(true);
    expect(readFileSync(join(setupOne.dataDir, "registry.json"), "utf8")).not.toContain("native answer");
  });

  it("hydrates Codex tool calls and outputs through the same public activity contract", async () => {
    const setupOne = await setup();
    const project = await createProject(setupOne.url, setupOne.workspace);
    const codex = await createAgent(setupOne.url, project, "codex", "codex-history-agent");
    await postJson(`${setupOne.url}/api/agents/${codex.id}/messages`, {
      prompt: "establish codex history",
      attachments: [],
      idempotencyKey: "codex-history-turn",
    });
    await waitForIdle(setupOne.url, project.id, codex.id);
    await setupOne.app.close();

    const sessionDir = join(setupOne.homeDir, ".codex", "sessions", "2026", "07", "15");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `rollout-${CODEX_SESSION}.jsonl`), [
      JSON.stringify({
        timestamp: "2026-07-15T10:00:00.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "historic tool turn" }] },
      }),
      JSON.stringify({
        timestamp: "2026-07-15T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "historic-call-1",
          name: "exec",
          input: JSON.stringify({ cmd: "env ACCESS_TOKEN=historic-input-secret npm test" }),
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-15T10:00:01.025Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "historic-call-1",
          output: "api_key=historic-output-secret all green",
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-15T10:00:02.000Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Historic tools complete." }] },
      }),
      JSON.stringify({ timestamp: "2026-07-15T10:00:02.100Z", type: "event_msg", payload: { type: "task_complete" } }),
      "",
    ].join("\n"));

    const restarted = createWebUi({
      dataDir: setupOne.dataDir,
      homeDir: setupOne.homeDir,
      legacyDataDir: null,
      spawnProcess: fakeSpawn([]),
      appendEventImpl: () => {},
    });
    const second = await restarted.listen({ port: 0 });
    cleanups.push(() => restarted.close());
    const events = (await request(`${second.url}/api/agents/${codex.id}/history`)).body.events;
    const tools = events.filter((event) => event.subtype === "tool");
    expect(tools).toEqual([
      expect.objectContaining({
        toolId: "historic-call-1",
        name: "exec",
        phase: "started",
        historical: true,
      }),
      expect.objectContaining({
        toolId: "historic-call-1",
        name: "exec",
        phase: "completed",
        historical: true,
        durationMs: 25,
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("historic-input-secret");
    expect(JSON.stringify(events)).not.toContain("historic-output-secret");
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
    expect(page.body).toContain("prompt-overview-button");
    expect(page.body).toContain("data-prompt-scope=\"project\"");
    expect(page.body).toContain("pinned-conversations-button");
    expect(page.body).toContain("pin-conversation-button");
    expect(page.body).toContain("theme-toggle");
    expect(page.body).toContain('meta name="theme-color"');
    expect(page.body).toContain('<html lang="en">');
    expect(page.body).toContain("Paste images or drop files here");
    expect(page.body).toContain("Weekly quotas for Claude and Codex");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    const style = (await request(`${url}/style.css`)).body;
    expect(style).toContain("--canvas: #f2f3ee");
    expect(style).toContain(':root[data-theme="dark"]');
    expect(style).toContain(":root:not([data-theme])");
    const app = (await request(`${url}/app.js`)).body;
    expect(app).toContain("/side-questions");
    expect(app).toContain("/compact");
    expect(app).toContain("/interrupt");
    expect(app).toContain("/api/prompts");
    expect(app).toContain("/pin");
    expect(app).toContain('THEME_STORAGE_KEY = "amux-code:color-theme"');
    expect(app).toContain('window.matchMedia("(prefers-color-scheme: dark)")');
    expect(app).toContain('window.addEventListener("storage"');
    expect(app).toContain('addEventListener("paste"');
    expect(app).toContain('"x-idempotency-key": crypto.randomUUID()');
    expect(app).toContain("handledPasteEvents");
    expect(app).toContain("Manage Claude quota");
    const serverSource = readFileSync(new URL("../spikes/web-ui/server.mjs", import.meta.url), "utf8");
    const swedishUiCopy = /[ÅÄÖåäö]|\b(?:Projekt|Agenter|Skapa|Nytt|Pinnade|Skickade|frågor|Klar|Arbetar|Avbryt|Pinna|Avpinna|Sidofråga|Skriv|Skicka|Släpp|Stäng|Mappen|Kontext|Ingen|Uppdatera|Instansen|arbetsmapp|behörighet|misslyckades|Åtgärden|Borttaget|Borttagen|Kvot|Vecka|använt|kvar|återställs|mätt|otillgänglig|Hämtar|Hantera)\b/iu;
    expect(`${page.body}\n${app}\n${serverSource}`).not.toMatch(swedishUiCopy);
    const config = await request(`${url}/api/config`);
    const health = await request(`${url}/api/health`);
    expect(health.body).toMatchObject({ ok: true, bootId: config.body.bootId, projects: 1, agents: 2 });
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
