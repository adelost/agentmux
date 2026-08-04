import { component, expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimBlocker, createWorkClient, formatTicketShow, formatWorkOverview, parseWorkArgs,
  projectForWorkSender, runWorkCommand,
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
      projectForWorkSender("ai:1"),
      projectForWorkSender("lsrc:4"), projectForWorkSender("unknown:1"),
      projectForWorkSender("unknown:1", "ai"),
    ]],
    then: ["known fleets map and an explicit override remains possible", (result) => {
      // `ai` belongs here: those panes have exactly one board, and its absence made
      // every ai command fail locally in a way that read as a permission error.
      // `lsrc` stays null ON PURPOSE — those panes orchestrate four boards, so a
      // default would be a silent wrong-project pick, not a convenience.
      expect(result).toEqual(["skyvw", "skydive", "ai", null, null, "ai"]);
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

  unit("renders omitted claimable and gated groups without hiding them", {
    when: ["formatting an overview with groups", () => formatWorkOverview(overview({
      readyOmitted: 2,
      readyGroups: { awaitingApproval: 1, held: 1, dependencyBlocked: 3 },
      awaitingApprovalCandidates: [{ id: "SVW-0101", title: "Needs approval", priority: "normal" }],
      heldCandidates: [{ id: "SVW-0102", title: "Risky change", priority: "high" }],
    }))],
    then: ["every group is visible but only claimable work sits under READY", (text) => {
      expect(text).toContain("+2 more claimable");
      expect(text).toContain("AWAITING APPROVAL 1");
      expect(text).toContain("SVW-0101 · Needs approval");
      expect(text).toContain("HELD 1");
      expect(text).toContain("SVW-0102 · Risky change");
      expect(text).toContain("DEPENDENCY-BLOCKED 3");
      expect(text.indexOf("READY")).toBeLessThan(text.indexOf("AWAITING APPROVAL"));
    }],
  });

  unit("shows one ticket with its true claimability and criteria", {
    when: ["formatting a held ticket detail", () => formatTicketShow({ ticket: {
      id: "SVW-0103", title: "Delete the world", status: "ready", revision: 4, priority: "high",
      productApproval: { state: "approved" },
      safety: { state: "held", executionBlocked: true },
      criteria: ["never advertised as claimable", "hold visible"],
    } })],
    then: ["the hold wins over approval and the criteria stay readable", (text) => {
      expect(text).toContain("SVW-0103 · Delete the world · high");
      expect(text).toContain("ready · revision 4 · approval approved · safety held");
      expect(text).toContain("CLAIMABLE no (safety hold)");
      expect(text).toContain("- never advertised as claimable");
    }],
  });

  component("show reads one ticket through the fleet key without mutation", {
    given: ["a worker pane and a fake board", () => ({ client: fakeClient([
      { ticket: { id: "SVW-0104", title: "Plain task", status: "ready", revision: 2,
        priority: "normal", productApproval: { state: "approved" }, criteria: [],
        problem: "Recorder output stops at the first silence gap",
        expected: "One full pass keeps every segment in order" } },
    ]) })],
    when: ["showing the ticket", ({ client }) => runWorkCommand(
      ["show", "SVW-0104"], { sender: "skyvw:4", client, baseUrl: "https://suggest.v1d.io" },
    )],
    then: ["a single read returns the claimable truth and the durable contract", (text, { client }) => {
      expect(client.calls).toEqual([{ kind: "read",
        path: "/api/tickets/SVW-0104?project=skyvw" }]);
      expect(text).toContain("CLAIMABLE yes");
      expect(text).toContain("PROBLEM");
      expect(text).toContain("Recorder output stops at the first silence gap");
      expect(text).toContain("EXPECTED");
      expect(text).toContain("One full pass keeps every segment in order");
    }],
  });

  component("creates one ticket and points to delegated terminal approval", {
    given: ["a manager pane and a fake board", () => ({ client: fakeClient() })],
    when: ["adding a concrete task", ({ client }) => runWorkCommand(
      ["add", "Recorder loses the final message after restart"],
      { sender: "skyvw:3", client, baseUrl: "https://suggest.v1d.io" },
    )],
    then: ["the fleet-key mutation is small and no GUI is required", (text, { client }) => {
      expect(client.calls[0]).toMatchObject({ path: "/api/agent/tickets?project=skyvw",
        method: "POST", body: { project: "skyvw",
          raw: "Recorder loses the final message after restart" } });
      expect(text).toContain("NEXT amux work approve SVW-0101");
    }],
  });

  component("registers a new pane once with the shared fleet key", {
    given: ["an unregistered pane", () => {
      const client = fakeClient();
      client.read = async () => { throw new Error("fleet-key-invalid"); };
      return { client };
    }],
    when: ["the pane joins its explicit project", ({ client }) => runWorkCommand(
      ["join", "--project", "skyvw"], { sender: "friend:7", client },
    )],
    then: ["the existing self-registration seam receives only pane identity", (text, { client }) => {
      expect(text).toBe("JOINED friend:7 · skyvw");
      expect(client.calls[0]).toMatchObject({ kind: "mutate",
        path: "/api/agent/register?project=skyvw", body: {
          agentId: "friend:7", displayName: "friend:7",
        } });
    }],
  });

  component("approves stable ticket material with delegated admin authority", {
    given: ["a READY ticket after triage", () => ({ client: fakeClient([
      { ticket: {
        id: "SVW-0101", status: "ready", revision: 4,
        productApproval: { state: "required", materialFingerprint: `material-v1:${"a".repeat(64)}` },
      } },
      { ticket: {
        id: "SVW-0101", status: "ready", revision: 5,
        productApproval: { state: "approved", materialFingerprint: `material-v1:${"a".repeat(64)}` },
      } },
    ]) })],
    when: ["the delegated pane approves it", ({ client }) => runWorkCommand(
      ["approve", "SVW-0101"], { sender: "skyvw:3", client },
    )],
    then: ["approval is revision- and material-bound without a GUI", (text, { client }) => {
      expect(text).toBe("APPROVED SVW-0101\nCLAIMABLE yes");
      expect(client.calls[1]).toMatchObject({ admin: true,
        path: "/api/agent/tickets/SVW-0101/product-approval?project=skyvw", body: {
          source: "skyvw:3", expectedTicketRevision: 4,
          materialFingerprint: `material-v1:${"a".repeat(64)}`,
        } });
    }],
  });

  // Measured on suggest.v1d.io 2026-08-04: SRC-0137 carried a policy safety flag
  // AND an unapproved product gate. `approve` cleared the second, printed a bare
  // APPROVED, and left executionBlocked true. Safety release is human-only by
  // design (/api/human/tickets/:id/safety-approval), so the hold is not a race
  // the caller can wait out — it is a different door, behind a different actor.
  const heldAfterApproval = (overrides = {}) => ({ ticket: {
    id: "SVW-0101", status: "ready", revision: 4,
    productApproval: { state: "approved", materialFingerprint: `material-v1:${"a".repeat(64)}` },
    safety: { state: "held", executionBlocked: true },
    ...overrides,
  } });

  unit("names the surviving gate, not the one just opened", {
    given: ["a product-approved ticket that policy still holds", () => heldAfterApproval().ticket],
    when: ["asking what blocks the claim", (ticket) => claimBlocker(ticket)],
    then: ["the answer is the hold", (reason) => expect(reason).toBe("safety hold")],
  });

  component("does not report bare success while the ticket stays held", {
    given: ["a held ticket whose product gate the mutation clears", () => ({
      client: fakeClient([
        heldAfterApproval({ productApproval: { state: "required",
          materialFingerprint: `material-v1:${"a".repeat(64)}` } }),
        heldAfterApproval(),
      ]) })],
    when: ["approving it", ({ client }) => runWorkCommand(
      ["approve", "SVW-0101"], { sender: "skyvw:3", client },
    )],
    then: ["the caller learns the claim is still blocked, and by whom", (text) => {
      expect(text).toContain("APPROVED SVW-0101");
      expect(text).toContain("CLAIMABLE no (safety hold)");
      expect(text).toContain("NEEDS HUMAN POST /api/human/tickets/SVW-0101/safety-approval");
    }],
  });

  component("keeps the already-approved shortcut equally honest", {
    given: ["a ticket approved earlier and held since", () => ({
      client: fakeClient([heldAfterApproval()]) })],
    when: ["approving it again", ({ client }) => runWorkCommand(
      ["approve", "SVW-0101"], { sender: "skyvw:3", client },
    )],
    then: ["the shortcut reports the hold and sends no mutation", (text, { client }) => {
      expect(text).toContain("(already)");
      expect(text).toContain("CLAIMABLE no (safety hold)");
      expect(client.calls.filter((call) => call.kind === "mutate")).toHaveLength(0);
    }],
  });

  component("says unverified rather than replaying stale state", {
    given: ["a board that answers the confirming re-read with nothing", () => {
      const reads = [heldAfterApproval({ safety: { state: "clear", executionBlocked: false },
        productApproval: { state: "required",
          materialFingerprint: `material-v1:${"a".repeat(64)}` } })];
      return { client: { calls: [],
        read: async () => reads.shift() ?? null,
        mutate: async () => ({ ok: true }) } };
    }],
    when: ["approving it", ({ client }) => runWorkCommand(
      ["approve", "SVW-0101"], { sender: "skyvw:3", client },
    )],
    then: ["the missing confirmation is stated, not guessed", (text) => {
      expect(text).toBe("APPROVED SVW-0101\nCLAIMABLE unverified (re-read returned no ticket)");
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

  component("rejects malformed merge evidence before terminal mutation", {
    given: ["active work and a non-GitHub URL", () => ({ client: fakeClient([overview({
      agent: { id: "skyvw:4", currentTicket: "SVW-0100", assignmentGeneration: 2 },
    })]) })],
    when: ["completion is attempted", ({ client }) => runWorkCommand([
      "done", "--tests", "manual smoke", "--merge", "https://example.test/not-a-commit",
    ], { sender: "skyvw:4", client }).catch((error) => error)],
    then: ["the CLI explains the evidence boundary and sends no write", (error, { client }) => {
      expect(error.message).toContain("GitHub commit or pull-request URL");
      expect(client.calls).toHaveLength(1);
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
