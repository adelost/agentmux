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
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit("close", 143);
    calls.push({ command, args: [...args], options });

    queueMicrotask(() => {
      const lines = [];
      if (command === "fake-claude") {
        const prompt = args[args.indexOf("-p") + 1];
        if (prompt.startsWith("[SIDOFRÅGA")) {
          lines.push({ type: "result", subtype: "success", result: `SIDE_OK: ${prompt.split("\n").at(-1)}` });
        } else {
          lines.push({ type: "system", subtype: "init", session_id: CLAUDE_SESSION });
          lines.push({
            type: "assistant",
            session_id: CLAUDE_SESSION,
            message: { content: [{ type: "text", text: "CLAUDE_OK" }] },
          });
          lines.push({
            type: "result",
            subtype: "success",
            session_id: CLAUDE_SESSION,
            duration_ms: 12,
            total_cost_usd: 0,
          });
        }
      } else {
        lines.push({ type: "thread.started", thread_id: CODEX_SESSION });
        lines.push({ type: "item.completed", item: { type: "agent_message", text: "CODEX_OK" } });
        lines.push({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } });
      }
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", 0));
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

async function setup() {
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
    expect(calls[0].args.join(" ")).toContain(upload.body.path);

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
    expect(codexCall.args).toContain("-C");
    expect(codexCall.args).toContain(workspace);

    const history = await request(`${url}/api/agents/${codex.id}/history`);
    expect(history.body.events.some((event) => event.message?.content?.[0]?.text === "CODEX_OK")).toBe(true);
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
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "native answer" }] } }),
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
    const history = await request(`${second.url}/api/agents/${agent.id}/history`);
    expect(history.body.events.map((event) => event.text || event.message?.content?.[0]?.text))
      .toEqual(expect.arrayContaining(["native question", "native answer"]));
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
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect((await request(`${url}/style.css`)).body).toContain("--canvas: #f2f3ee");
    expect((await request(`${url}/app.js`)).body).toContain("/side-questions");
  });
});
