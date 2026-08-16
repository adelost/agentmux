import { expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendSuggestionsRequest } from "./suggestions-authoring.mjs";

const quote = "Behåll ÅÄÖåäö exakt.";

// Every send writes an envelope. What the envelope must say is what the operator
// has to DO with it: replay it, never replay it, or verify it against the board
// first. A single "staged" for all three makes the pile untriageable.
const send = async ({ mutationId, fetchImpl, readPath }) => {
  const root = mkdtempSync(join(tmpdir(), "amux-outbox-outcome-"));
  const bodyFile = join(root, "request.json");
  const stateDir = join(root, "outbox");
  writeFileSync(bodyFile, `${JSON.stringify({ mutationId, source: "ai:4", comment: quote })}\n`);
  const error = await sendSuggestionsRequest({
    baseUrl: "https://tasks.example.test",
    method: "PATCH", path: "/api/tickets/AI-0014/admin?project=ai",
    bodyFile, readPath, token: "test-token", stateDir, fetchImpl,
  }).then(() => null, (failure) => failure);
  return {
    error,
    envelope: JSON.parse(readFileSync(join(stateDir, `${mutationId}.json`), "utf8")),
  };
};

feature("The authoring outbox records what an attempt did, not that it began", () => {
  unit("a rejected mutation is marked rejected and carries its status", {
    given: ["a server that refuses the mutation", () => ({
      mutationId: "22222222-2222-4222-8222-222222222222",
      fetchImpl: async () => new Response(`{"error":"source-required"}`, { status: 400 }),
    })],
    when: ["the send is attempted", (options) => send(options)],
    then: ["the envelope says it was answered, not that it never left", ({ envelope }) => {
      expect(envelope.state).toBe("rejected");
      expect(envelope.lastStatus).toBe(400);
      expect(envelope.lastError).toContain("source-required");
      expect(envelope.attemptedAt).toEqual(expect.any(String));
    }],
  });

  unit("a mutation the server applied is never left looking unsent", {
    given: ["a server that applies the write, then fails the readback", () => ({
      mutationId: "33333333-3333-4333-8333-333333333333",
      readPath: "/api/tickets/AI-0014?project=ai",
      fetchImpl: async (_url, options) => (options?.method
        ? new Response("{}")
        : new Response("{}", { status: 503 })),
    })],
    when: ["the send is attempted", (options) => send(options)],
    then: ["it is flagged as applied but unverified, so nobody replays it", ({ envelope }) => {
      expect(envelope.state).toBe("applied_unverified");
      expect(envelope.lastStatus).toBe(200);
    }],
  });

  unit("a request that never reached the server is distinguishable from both", {
    given: ["a transport that throws before any response", () => ({
      mutationId: "44444444-4444-4444-8444-444444444444",
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    })],
    when: ["the send is attempted", (options) => send(options)],
    then: ["the envelope names the failure and has no status", ({ envelope }) => {
      expect(envelope.state).toBe("send_failed");
      expect(envelope.lastStatus).toBeNull();
      expect(envelope.lastError).toContain("ECONNREFUSED");
    }],
  });

  unit("a successful send still acknowledges, and now says with what status", {
    given: ["a server that accepts the mutation", () => ({
      mutationId: "55555555-5555-4555-8555-555555555555",
      fetchImpl: async () => new Response("{}"),
    })],
    when: ["the send is attempted", (options) => send(options)],
    then: ["the receipt is unchanged apart from being explicit", ({ error, envelope }) => {
      expect(error).toBeNull();
      expect(envelope.state).toBe("acknowledged");
      expect(envelope.lastStatus).toBe(200);
      expect(envelope.acknowledgedAt).toEqual(expect.any(String));
    }],
  });
});
