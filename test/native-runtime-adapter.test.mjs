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

function setup({ loseFirstResponse = true, message404Once = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-native-adapter-"));
  const workspace = join(root, "workspace");
  const queueDir = join(root, "queue");
  const attachment = join(root, "proof.png");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(attachment, "not-a-real-png");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  const calls = [];
  let messageAccepted = false;
  let messageCompleted = null;
  let loseFirstMessageResponse = loseFirstResponse;
  let returnMessage404 = message404Once;
  const agent = {
    id: "22222222-2222-4222-8222-222222222222",
    projectId: "11111111-1111-4111-8111-111111111111",
    name: "skybar-canary:0",
    engine: "claude",
    model: "claude-sonnet-4-5",
    effort: "medium",
    address: { session: "skybar-canary", pane: 0 },
    permissionMode: "automation",
    running: false,
    context: { percent: 42.4, usedTokens: 84_800 },
    updatedAt: 100,
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
      const operationKey = calls.find((call) => call.path.endsWith("/messages"))?.body?.idempotencyKey;
      const events = !messageAccepted ? [] : [
        { type: "web", subtype: "user", operationKey },
        ...(messageCompleted ? [{
          type: "web",
          subtype: "turn-done",
          operationKey,
          code: messageCompleted.code,
          error: messageCompleted.error,
          interrupted: Boolean(messageCompleted.interrupted),
        }] : []),
      ];
      return jsonResponse({
        bootId: "boot-1",
        agent,
        events,
        operations: messageCompleted ? [{
          operationKey,
          code: messageCompleted.code,
          error: messageCompleted.error,
          interrupted: Boolean(messageCompleted.interrupted),
        }] : [],
      });
    }
    if (path === `/api/agents/${agent.id}` && options.method === "PATCH") {
      Object.assign(agent, body);
      delete agent.idempotencyKey;
      agent.updatedAt += 1;
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
      if (returnMessage404) {
        returnMessage404 = false;
        return jsonResponse({ error: "agent-not-found" }, 404);
      }
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
  return {
    root,
    workspace,
    queueDir,
    attachment,
    calls,
    nativeRuntime,
    agent,
    completeMessage(code = 0, error = null, interrupted = false) {
      messageCompleted = { code, error, interrupted };
      agent.running = false;
    },
  };
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
      address: { session: "skybar-canary", pane: 0 },
      permissionMode: "automation",
    });
    expect(agentCreate.body).not.toHaveProperty("model");
    expect(agentCreate.body).not.toHaveProperty("effort");
    const configuredSettings = calls.find((call) =>
      call.path === `/api/agents/${agent.id}`
      && call.body?.idempotencyKey?.startsWith("amux-config-settings:"));
    expect(configuredSettings.body).toMatchObject({
      model: "claude-opus-4-8",
      effort: "high",
    });
    await expect(nativeRuntime.getContext("skybar-canary", 0)).resolves.toMatchObject({
      percent: 42,
      tokens: 84_800,
      source: "native-runtime",
    });
  });

  it("treats a malformed native pane as non-native for routing but rejects explicit provisioning", async () => {
    const { nativeRuntime } = setup();
    expect(nativeRuntime.isNativeTarget("skybar-canary", 99)).toBe(false);
    await expect(nativeRuntime.ensureTarget("skybar-canary", 99)).rejects.toMatchObject({
      code: "invalid-native-target",
    });
  });

  it("survives a lost accept response and acknowledges exactly one queued turn on retry", async () => {
    const { queueDir, attachment, calls, nativeRuntime, completeMessage } = setup();
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

    completeMessage(0);
    clock = 10_000;
    await broker.kickTarget("skybar-canary", 0);
    expect(queue.read(job.agentName, job.pane, job.id)).toMatchObject({
      status: "submitted",
      attempts: 2,
      metadata: { deliveryTransport: "native" },
    });
    clock = 12_000;
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
    expect(messages[0].body.source).toBe("test");
  });

  it("reprovisions a missing cached agent and retries the same operation key once", async () => {
    const { nativeRuntime, calls } = setup({ loseFirstResponse: false, message404Once: true });
    const result = await nativeRuntime.deliverQueued({
      id: "stale-agent",
      agentName: "skybar-canary",
      pane: 0,
      kind: "prompt",
      text: "continue after registry replacement",
    });

    expect(result).toMatchObject({
      accepted: true,
      completionPending: true,
      operationKey: "delivery:stale-agent",
    });
    const creates = calls.filter((call) => call.path.endsWith("/agents"));
    const messages = calls.filter((call) => call.path.endsWith("/messages"));
    expect(creates).toHaveLength(2);
    expect(messages).toHaveLength(2);
    expect(messages[0].body.idempotencyKey).toBe("delivery:stale-agent");
    expect(messages[1].body.idempotencyKey).toBe(messages[0].body.idempotencyKey);
  });

  it("terminalizes an accepted native turn failure without redispatching it", async () => {
    const { queueDir, calls, nativeRuntime, completeMessage } = setup({ loseFirstResponse: false });
    let clock = 1_000;
    const notices = [];
    const queue = createDeliveryQueue({ rootDir: queueDir, now: () => clock });
    const broker = createDeliveryBroker({
      agent: nativeRuntime,
      queue,
      now: () => clock,
      notify: async (job, kind) => notices.push({ job: structuredClone(job), kind }),
    });
    const job = queue.enqueue({
      agentName: "skybar-canary",
      pane: 0,
      text: "fail immediately",
      source: "test",
      idempotencyKey: "native-failed-turn",
    });

    await broker.kickTarget("skybar-canary", 0);
    expect(queue.read(job.agentName, job.pane, job.id).status).toBe("submitted");
    completeMessage(1, "engine exited before completion");
    clock = 2_000;
    await broker.kickTarget("skybar-canary", 0);

    const terminal = queue.read(job.agentName, job.pane, job.id);
    expect(terminal).toMatchObject({
      status: "delivered_unverified",
      attempts: 1,
      metadata: {
        deliveryTransport: "native",
        deliveryAmbiguity: "native-turn-failed",
      },
      lastReason: expect.stringContaining("engine exited before completion"),
    });
    expect(notices).toEqual([expect.objectContaining({ kind: "unverified" })]);
    expect(calls.filter((call) => call.path.endsWith("/messages"))).toHaveLength(1);
  });

  it("settles an explicitly interrupted native turn without retrying or calling it failed", async () => {
    const { queueDir, calls, nativeRuntime, completeMessage } = setup({ loseFirstResponse: false });
    let clock = 1_000;
    const queue = createDeliveryQueue({ rootDir: queueDir, now: () => clock });
    const broker = createDeliveryBroker({ agent: nativeRuntime, queue, now: () => clock });
    const job = queue.enqueue({
      agentName: "skybar-canary",
      pane: 0,
      text: "long task that the operator interrupts",
      source: "test",
      idempotencyKey: "native-interrupted-turn",
    });

    await broker.kickTarget("skybar-canary", 0);
    completeMessage(1, "interrupted by operator", true);
    clock = 2_000;
    await broker.kickTarget("skybar-canary", 0);

    expect(queue.read(job.agentName, job.pane, job.id)).toMatchObject({
      status: "acknowledged",
      attempts: 1,
    });
    expect(calls.filter((call) => call.path.endsWith("/messages"))).toHaveLength(1);
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
    const patchCall = calls.find((call) =>
      call.path === `/api/agents/${agent.id}`
      && call.body?.idempotencyKey === "delivery:model-change");
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
