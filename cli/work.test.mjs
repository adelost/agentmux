import { component, expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkClient, formatWorkOverview, parseWorkArgs, projectForWorkSender, runWorkCommand,
} from "./work.mjs";

const overview = (overrides = {}) => ({
  agent: { id: "skyvw:4", workStatus: "idle", currentTicket: null },
  project: { id: "skyvw", activeWorkers: 1, maxActiveWorkers: 2 },
  pendingActions: [], readyCandidates: [{ id: "SVW-0100", title: "Fix recorder", priority: "high" }],
  ...overrides,
});

const fakeClient = (reads = []) => {
  const calls = [];
  return { calls,
    read: async (path) => { calls.push({ kind: "read", path }); return reads.shift() ?? overview(); },
    mutate: async (path, method, body, admin = false) => {
      calls.push({ kind: "mutate", path, method, body, admin });
      return { ticket: { id: body.ticketId ?? "SVW-0101", title: "Created ticket" } };
    } };
};

feature("simple Suggestions work CLI", () => {
  unit("infers only the small known project map", {
    when: ["mapping pane addresses", () => [
      projectForWorkSender("skyvw:3"), projectForWorkSender("skydive:9"),
      projectForWorkSender("lsrc:4"), projectForWorkSender("unknown:1"),
      projectForWorkSender("unknown:1", "ai"),
    ]],
    then: ["known fleets map and an explicit override remains possible", (result) => {
      expect(result).toEqual(["skyvw", "skydive", "source", null, "ai"]);
    }],
  });

  unit("parses quoted values without inventing workflow flags", {
    when: ["parsing a waiting check-in", () => parseWorkArgs([
      "wait", "Device unavailable", "--wake", "Phone is online", "--hours=3",
    ])],
    then: ["the action, reason and bounded options remain distinct", (result) => {
      expect(result).toEqual({ action: "wait", positional: ["Device unavailable"], help: false,
        options: { wake: "Phone is online", hours: "3" } });
    }],
  });

  unit("renders only current work, capacity, responses and five READY choices", {
    when: ["formatting an overview", () => formatWorkOverview(overview({
      agent: { id: "skyvw:4", workStatus: "working", currentTicket: "SVW-0099" },
      pendingActions: [{ kind: "human_comment" }],
      recentTickets: [{ id: "SVW-0098", title: "Previous delivery", status: "done",
        delivery: { commit: { shortSha: "abc12345" } } }],
    }))],
    then: ["the terminal summary stays compact", (text) => {
      expect(text).toContain("skyvw · skyvw:4 · working");
      expect(text).toContain("CURRENT SVW-0099");
      expect(text).toContain("NEEDS RESPONSE human_comment");
      expect(text).toContain("SVW-0100 · Fix recorder · high");
      expect(text).toContain("SVW-0098 · Previous delivery · done · abc12345");
    }],
  });

  component("creates one ticket and points to the existing human approval page", {
    given: ["a manager pane and a fake board", () => ({ client: fakeClient() })],
    when: ["adding a concrete task", ({ client }) => runWorkCommand(
      ["add", "Recorder loses the final message after restart"],
      { sender: "skyvw:3", client, baseUrl: "https://suggest.v1d.io" },
    )],
    then: ["the fleet-key mutation is small and approval stays human", (text, { client }) => {
      expect(client.calls[0]).toMatchObject({ path: "/api/agent/tickets?project=skyvw",
        method: "POST", body: { project: "skyvw",
          raw: "Recorder loses the final message after restart" } });
      expect(text).toContain("APPROVE https://suggest.v1d.io/?project=skyvw&ticket=SVW-0101");
    }],
  });

  component("keeps the manager out of implementation claims", {
    when: ["pane 3 tries to claim", () => runWorkCommand(["claim", "SVW-0100"],
      { sender: "skyvw:3", client: fakeClient() }).catch((error) => error)],
    then: ["the CLI explains the sidecar role before HTTP", (error) => {
      expect(error.message).toContain("manager");
    }],
  });

  component("claims the current ticket revision instead of guessing", {
    given: ["an approved detail at revision seven", () => ({ client: fakeClient([
      { ticket: { id: "SVW-0100", revision: 7 } },
    ]) })],
    when: ["a worker explicitly claims it", ({ client }) => runWorkCommand(
      ["claim", "SVW-0100"], { sender: "skyvw:4", client },
    )],
    then: ["the atomic claim carries the observed revision", (_text, { client }) => {
      expect(client.calls[1]).toMatchObject({ path: "/api/agent/claim", method: "POST",
        body: { ticketId: "SVW-0100", expectedTicketRevision: 7 } });
    }],
  });

  component("turns waiting state into an observable wake contract", {
    given: ["active work at generation four", () => ({ client: fakeClient([overview({
      agent: { id: "skyvw:4", currentTicket: "SVW-0100", assignmentGeneration: 4 },
    })]) })],
    when: ["the worker records a wait", ({ client }) => runWorkCommand([
      "wait", "Need the phone", "--wake", "Phone appears in adb", "--hours", "1",
    ], { sender: "skyvw:4", client })],
    then: ["the durable check-in is waiting rather than terminal", (_text, { client }) => {
      expect(client.calls[1]).toMatchObject({ path: "/api/agent/check-in", body: {
        ticketId: "SVW-0100", assignmentGeneration: 4, status: "waiting",
        reason: "Need the phone", wakeCondition: "Phone appears in adb",
      } });
      expect(client.calls[1].body.nextCheckAt).toBeGreaterThan(Date.now());
    }],
  });

  component("closes through one generation-bound receipt using focused proof", {
    given: ["active work and a known commit", () => ({ client: fakeClient([overview({
      agent: { id: "skyvw:4", currentTicket: "SVW-0100", assignmentGeneration: 2 },
    })]) })],
    when: ["the worker reports done", ({ client }) => runWorkCommand([
      "done", "--tests", "7 focused tests and manual phone smoke", "--merge",
      "https://github.com/adelost/repo/commit/abc", "--live", "Phone smoke passed",
    ], { sender: "skyvw:4", client, commitLabel: "fix: preserve recorder state" })],
    then: ["the admin token is used only for the terminal receipt", (_text, { client }) => {
      expect(client.calls[1]).toMatchObject({ admin: true, method: "PATCH",
        path: "/api/tickets/SVW-0100/admin?project=skyvw", body: { source: "skyvw:4",
          status: "done", terminalAssignmentGeneration: 2, completionReceipt: {
            assignmentGeneration: 2,
            merge: [{ label: "fix: preserve recorder state",
              url: "https://github.com/adelost/repo/commit/abc" }],
            tests: [{ label: "7 focused tests and manual phone smoke", url: null }],
            live: [{ label: "Phone smoke passed", url: null }],
          } } });
    }],
  });

  component("sends fleet identity through the durable authoring transport", {
    given: ["a private staging directory", () => {
      const stateDir = mkdtempSync(join(tmpdir(), "amux-work-test-"));
      const requests = [];
      const fetchImpl = async (url, options) => {
        requests.push({ url: String(url), options });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };
      return { stateDir, requests, client: createWorkClient({
        baseUrl: "https://suggest.test", sender: "skyvw:4", fleetToken: "fleet",
        adminToken: "admin", fetchImpl, stateDir,
      }) };
    }],
    when: ["sending a check-in", ({ client }) => client.mutate("/api/agent/check-in", "POST",
      { mutationId: crypto.randomUUID(), ticketId: "SVW-1" })],
    then: ["the token stays in headers and the pane identity is explicit", (_result, ctx) => {
      expect(ctx.requests[0].options.headers).toMatchObject({ authorization: "Bearer fleet",
        "x-agent-id": "skyvw:4" });
      expect(String(ctx.requests[0].options.body)).not.toContain("fleet");
      rmSync(ctx.stateDir, { recursive: true, force: true });
    }],
  });
});
