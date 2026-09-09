import { describe, expect, it, vi } from "vitest";
import { createNativeRuntimeClient } from "../core/native-runtime-client.mjs";

function fixture({ adopted = false, listingChange = () => {}, responseChange = () => {}, missingHistory = false } = {}) {
  const agent = { id: "agent-1", projectId: "project-1", engine: "claude", sessionId: "session-1",
    cwd: "/project", address: { session: "native-test", pane: 0 }, permissionMode: "interactive",
    model: "chosen-model", effort: "high", running: false, context: { percent: 10, usedTokens: 1000 } };
  const project = { id: "project-1", cwd: "/project", agents: [agent] };
  const listing = { projects: [project] }; listingChange(listing);
  const calls = [], unpark = vi.fn();
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method });
    let value, status = 200;
    if (path === "/api/health") value = { ok: true };
    else if (path === "/api/projects") value = options.method === "GET" ? listing : project;
    else if (path === "/api/projects/project-1/agents") value = agent;
    else if (path === "/api/agents/agent-1" && options.method === "PATCH") {
      Object.assign(agent, JSON.parse(options.body)); value = agent;
    } else if (path === "/api/agents/agent-1/history") {
      value = { agent: structuredClone(agent), events: [], operations: [] }; responseChange(value);
      if (missingHistory) { status = 404; value = { error: "agent-not-found" }; }
    } else throw new Error(`unexpected request ${path}`);
    return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  };
  const client = createNativeRuntimeClient({ fetchImpl, unparkImpl: unpark, loadConfigImpl: () => ({
    "native-test": { backend: "native", dir: "/project", panes: [{ engine: "claude",
      model: "old-configured-model", effort: "medium", ...(adopted ? { nativeAgentId: "agent-1" } : {}) }] },
  }) });
  return { client, calls, unpark, agent };
}
const onlyReads = fx => {
  expect(fx.calls.every(call => call.method === "GET")).toBe(true);
  expect(fx.unpark).not.toHaveBeenCalled();
};

describe("native observation never provisions or reconfigures sessions", () => {
  it("reads current context, status and receipts without applying configured defaults", async () => {
    const fx = fixture();
    await expect(fx.client.getContext("native-test")).resolves.toMatchObject({ model: "chosen-model", effort: "high" });
    await expect(fx.client.isBusy("native-test")).resolves.toBe(false);
    await expect(fx.client.deliveryStatus({ agentName: "native-test", pane: 0, id: "unseen" })).resolves.toMatchObject({ state: "unknown" });
    onlyReads(fx);
  });
  it.each([
    ["absent", value => { value.projects = []; }],
    ["ambiguous", value => { value.projects[0].agents.push({ ...value.projects[0].agents[0], id: "duplicate" }); }],
    ["other cwd", value => { value.projects[0].cwd = "/other"; }],
    ["other engine", value => { value.projects[0].agents[0].engine = "codex"; }],
  ])("rejects an %s target without creating a replacement", async (_label, listingChange) => {
    const fx = fixture({ listingChange });
    await expect(fx.client.history("native-test")).rejects.toMatchObject({ code: "native-observation-target-mismatch" });
    onlyReads(fx);
  });
  it("does not repair a 404 by creating another agent", async () => {
    const fx = fixture({ missingHistory: true });
    await expect(fx.client.history("native-test")).rejects.toMatchObject({ status: 404 });
    onlyReads(fx);
    expect(fx.calls.filter(call => call.path.endsWith("/history"))).toHaveLength(1);
  });
  it("rejects a session changing between identity and history reads", async () => {
    const fx = fixture({ responseChange: value => { value.agent.sessionId = "another-session"; } });
    await expect(fx.client.history("native-test")).rejects.toMatchObject({ code: "native-observation-session-changed" });
    onlyReads(fx);
  });
  it("reads an explicitly adopted session without binding it or changing permissions", async () => {
    const fx = fixture({ adopted: true, listingChange: value => { value.projects[0].agents[0].address = null; } });
    await expect(fx.client.history("native-test")).resolves.toMatchObject({ agent: { sessionId: "session-1", permissionMode: "interactive", address: null } });
    onlyReads(fx);
  });
  it("rejects an adopted session explicitly bound to another pane", async () => {
    const fx = fixture({ adopted: true, listingChange: value => { value.projects[0].agents[0].address.pane = 1; } });
    await expect(fx.client.history("native-test")).rejects.toMatchObject({ code: "native-observation-target-mismatch" });
    onlyReads(fx);
  });
});
