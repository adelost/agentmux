import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeRuntimeClient } from "../core/native-runtime-client.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { createDeliveryBroker } from "../core/delivery-broker.mjs";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "amux-native-adapter-"));
  const workspace = join(root, "workspace");
  const queueDir = join(root, "queue");
  const attachment = join(root, "proof.png");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(attachment, "not-a-real-png");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  const calls = [];
  let messageAccepted = false;
  let loseFirstMessageResponse = true;
  const agent = {
    id: "22222222-2222-4222-8222-222222222222",
    projectId: "11111111-1111-4111-8111-111111111111",
    name: "skybar-canary:0",
    engine: "claude",
    model: "claude-opus-4-8",
    effort: "high",
    address: { session: "skybar-canary", pane: 0 },
    permissionMode: "automation",
    running: false,
    context: { percent: 42.4, usedTokens: 84_800 },
  };

  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = options.body && options.headers?.["content-type"] === "application/json"
      ? JSON.parse(options.body)
      : null;
    calls.push({ path, method: options.method || "GET", body, headers: options.headers });
    if (path === "/api/health") return jsonResponse({ ok: true, bootId: "boot-1" });
    if (path === "/api/projects" && options.method === "POST") {
      return jsonResponse({
        id: agent.projectId,
        name: body.name,
        cwd: body.cwd,
        agents: [],
      }, 201);
    }
    if (path === `/api/projects/${agent.projectId}/agents`) return jsonResponse(agent, 201);
    if (path === `/api/agents/${agent.id}/history`) {
      return jsonResponse({ bootId: "boot-1", agent, events: [] });
    }
    if (path === `/api/agents/${agent.id}` && options.method === "PATCH") {
      Object.assign(agent, body);
      delete agent.idempotencyKey;
      return jsonResponse(agent);
    }
    if (path === `/api/agents/${agent.id}/compact` && options.method === "POST") {
      return jsonResponse(agent, 202);
    }
    if (path === `/api/projects/${agent.projectId}/uploads`) {
      return jsonResponse({
        path: "/runtime/uploads/proof.png",
        name: "proof.png",
        image: true,
        replayed: calls.filter((call) => call.path === path).length > 1,
      }, 201);
    }
    if (path === `/api/agents/${agent.id}/messages`) {
      if (!messageAccepted) messageAccepted = true;
      if (loseFirstMessageResponse) {
        loseFirstMessageResponse = false;
        throw new Error("socket closed after accept");
      }
      return jsonResponse({ ...agent, replayed: true });
    }
    return jsonResponse({ error: "route-not-found" }, 404);
  };

  const config = {
    "skybar-canary": {
      id: "canary-config-id",
      dir: workspace,
      backend: "native",
      runtimeUrl: "http://127.0.0.1:8811",
      panes: [{
        name: "claude",
        cmd: "native:claude",
        engine: "claude",
        model: "claude-opus-4-8",
        effort: "high",
      }],
    },
  };
  const nativeRuntime = createNativeRuntimeClient({
    configPath: "unused",
    fetchImpl,
    loadConfigImpl: () => config,
  });
  return { root, workspace, queueDir, attachment, calls, nativeRuntime, agent };
}

describe("native runtime compatibility adapter", () => {
  it("provisions a stable automation identity and exposes native context", async () => {
    const { nativeRuntime, workspace, calls, agent } = setup();
    const resolved = await nativeRuntime.ensureTarget("skybar-canary", 0);
    expect(resolved.agent.id).toBe(agent.id);
    const projectCreate = calls.find((call) => call.path === "/api/projects");
    expect(projectCreate.body).toMatchObject({ cwd: workspace, name: "AMUX · skybar-canary" });
    const agentCreate = calls.find((call) => call.path.endsWith("/agents"));
    expect(agentCreate.body).toMatchObject({
      engine: "claude",
      model: "claude-opus-4-8",
      effort: "high",
      address: { session: "skybar-canary", pane: 0 },
      permissionMode: "automation",
    });
    await expect(nativeRuntime.getContext("skybar-canary", 0)).resolves.toMatchObject({
      percent: 42,
      tokens: 84_800,
      source: "native-runtime",
    });
  });

  it("survives a lost accept response and acknowledges exactly one queued turn on retry", async () => {
    const { queueDir, attachment, calls, nativeRuntime } = setup();
    let clock = 1_000;
    const queue = createDeliveryQueue({ rootDir: queueDir, now: () => clock });
    const broker = createDeliveryBroker({
      agent: nativeRuntime,
      queue,
      now: () => clock,
      notify: async () => {},
    });
    const job = queue.enqueue({
      agentName: "skybar-canary",
      pane: 0,
      text: `Inspect this\n[image attached: ${attachment}]`,
      source: "test",
      idempotencyKey: "native-lost-response",
    });

    await broker.kickTarget("skybar-canary", 0);
    expect(queue.read(job.agentName, job.pane, job.id)).toMatchObject({
      status: "pending",
      attempts: 1,
    });

    clock = 10_000;
    await broker.kickTarget("skybar-canary", 0);
    expect(queue.read(job.agentName, job.pane, job.id)).toMatchObject({
      status: "acknowledged",
      attempts: 2,
    });
    const messages = calls.filter((call) => call.path.endsWith("/messages"));
    expect(messages).toHaveLength(2);
    expect(messages[0].body.idempotencyKey).toBe(`delivery:${job.id}`);
    expect(messages[1].body.idempotencyKey).toBe(messages[0].body.idempotencyKey);
    expect(messages[0].body.attachments).toEqual([
      { path: "/runtime/uploads/proof.png", name: "proof.png" },
    ]);
    expect(messages[0].body.prompt).toBe("Inspect this");
  });

  it("applies a combined native model and effort change without restarting the session", async () => {
    const { nativeRuntime, calls, agent } = setup();
    await expect(nativeRuntime.deliverQueued({
      id: "model-change",
      agentName: "skybar-canary",
      pane: 0,
      kind: "slash",
      text: "/model claude-sonnet-4-5 high",
    })).resolves.toMatchObject({ accepted: true, via: "native-settings" });
    const patchCall = calls.find((call) => call.path === `/api/agents/${agent.id}`);
    expect(patchCall.body).toMatchObject({
      model: "claude-sonnet-4-5",
      effort: "high",
      idempotencyKey: "delivery:model-change",
    });
    expect(agent.sessionId).toBeUndefined();
  });

  it("preserves an orchestrator's compact focus in the native request", async () => {
    const { nativeRuntime, calls, agent } = setup();
    await expect(nativeRuntime.deliverQueued({
      id: "focused-compact",
      agentName: "skybar-canary",
      pane: 0,
      kind: "slash",
      text: "/compact preserve the active ticket and gate results",
    })).resolves.toMatchObject({ accepted: true, via: "native-compact" });
    const compact = calls.find((call) => call.path === `/api/agents/${agent.id}/compact`);
    expect(compact.body).toEqual({
      idempotencyKey: "delivery:focused-compact",
      focus: "preserve the active ticket and gate results",
    });
  });
});
