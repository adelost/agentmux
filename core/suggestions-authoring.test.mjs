import { component, expect, feature, unit } from "bdd-vitest";
import {
  mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertVerbatimSources, failureDetail, inspectSuggestionsMutationCommand, sendSuggestionsRequest,
} from "./suggestions-authoring.mjs";

const mutationId = "11111111-1111-4111-8111-111111111111";
const exactQuote = "Tycker färgborder här är lite för diskret — behåll ÅÄÖåäö exakt.";
const SUGGESTIONS_BASE_URL = "https://tasks.example.test";
process.env.SUGGEST_BASE_URL = SUGGESTIONS_BASE_URL;

const fixture = (comment = exactQuote) => {
  const root = mkdtempSync(join(tmpdir(), "amux-suggest-unicode-"));
  const bodyFile = join(root, "request.json");
  const expectFile = join(root, "quote.txt");
  const stateDir = join(root, "outbox");
  writeFileSync(bodyFile, `${JSON.stringify({ mutationId, source: "ai:4", comment }, null, 2)}\n`);
  writeFileSync(expectFile, `${exactQuote}\n`);
  return { root, bodyFile, expectFile, stateDir };
};

feature("Suggestions authoring boundary", () => {
  unit("blocks the reproduced inline Python mutation before HTTP", {
    when: ["inspecting the AI-0008 heredoc shape", () => inspectSuggestionsMutationCommand(`
python3 - <<'PY'
body={"comment":"modell-omladdning pa delade 3090:an, vilket kraver ett GPU-fonster"}
urllib.request.Request("https://tasks.example.test/api/tickets/AI-0008/admin?project=ai",
  data=json.dumps(body).encode(), method="PATCH")
PY`)],
    then: ["the command is denied at the authoring seam", (result) => {
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("UTF-8/verbatim source gate");
    }],
  });

  unit("keeps read-only calls and the canonical client available", {
    when: ["inspecting safe command forms", () => ({
      read: inspectSuggestionsMutationCommand(
        "curl 'https://tasks.example.test/api/tickets/AI-0014?project=ai'",
      ),
      client: inspectSuggestionsMutationCommand(
        "amux-suggest --method PATCH --base-url https://tasks.example.test --path /api/tickets/AI-0014/admin --body-file /tmp/body.json",
      ),
    })],
    then: ["neither is denied", ({ read, client }) => {
      expect(read.blocked).toBe(false);
      expect(client.blocked).toBe(false);
    }],
  });

  unit("treats one final line ending as quote-file framing", {
    given: ["a JSON body and quote files ending in LF or CRLF", () => ({
      body: Buffer.from(JSON.stringify({ comment: exactQuote }), "utf8"),
      sources: [Buffer.from(`${exactQuote}\n`), Buffer.from(`${exactQuote}\r\n`)],
    })],
    when: ["checking both source files", ({ body, sources }) => sources.map(
      (source) => assertVerbatimSources(body, [source]),
    )],
    then: ["only the file framing is removed", (results) => {
      expect(results).toEqual([[exactQuote], [exactQuote]]);
    }],
  });

  component("the installed hook turns the reproduced finding into a hard denial", {
    when: ["running the hook with a direct mutation", () => spawnSync(
      process.execPath,
      [resolve("bin/suggestions-write-guard.mjs")],
      {
        encoding: "utf8",
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "curl -X PATCH https://tasks.example.test/api/tickets/AI-0014/admin -d @body.json" },
        }),
      },
    )],
    then: ["Claude receives exit 2 and an actionable canonical path", (result) => {
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("BLOCKED:");
      expect(result.stderr).toContain("amux-suggest");
    }],
  });

  component("rejects a retyped ASCII quote before any network side effect", {
    given: ["an ASCII-degraded body and the exact human quote", () => {
      const ctx = fixture("Tycker fargborder har ar lite for diskret — behall AAOaao exakt.");
      ctx.calls = 0;
      ctx.send = () => sendSuggestionsRequest({
        method: "PATCH",
        path: "/api/tickets/AI-0014/admin?project=ai",
        bodyFile: ctx.bodyFile,
        expectFiles: [ctx.expectFile],
        readPath: "/api/tickets/AI-0014?project=ai",
        token: "test-token",
        stateDir: ctx.stateDir,
        fetchImpl: async () => { ctx.calls += 1; return new Response("{}"); },
      }).catch((error) => error);
      return ctx;
    }],
    when: ["preflighting the request", ({ send }) => send()],
    then: ["the mismatch is loud and fetch was never called", (error, ctx) => {
      expect(error.message).toContain("not present unchanged");
      expect(ctx.calls).toBe(0);
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  component("sends and reads back literal Swedish UTF-8 without changing technical keys", {
    given: ["a strict UTF-8 body and exact quote source", () => {
      const ctx = fixture();
      ctx.requests = [];
      ctx.fetchImpl = async (url, options = {}) => {
        ctx.requests.push({ url: String(url), options });
        if (options.method === "PATCH") {
          ctx.wireBytes = Buffer.from(options.body);
          return new Response(JSON.stringify({ ok: true }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          ticket: { id: "AI-0014" }, comments: [{ body: exactQuote }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      };
      return ctx;
    }],
    when: ["sending through the canonical file transport", (ctx) => sendSuggestionsRequest({
      method: "PATCH",
      path: "/api/tickets/AI-0014/admin?project=ai",
      bodyFile: ctx.bodyFile,
      expectFiles: [ctx.expectFile],
      readPath: "/api/tickets/AI-0014?project=ai",
      token: "test-token",
      stateDir: ctx.stateDir,
      fetchImpl: ctx.fetchImpl,
    })],
    then: ["wire bytes, readback, and durable request identity are exact", (result, ctx) => {
      expect(ctx.requests).toHaveLength(2);
      expect(ctx.wireBytes.equals(readFileSync(ctx.bodyFile))).toBe(true);
      expect(ctx.wireBytes.includes(Buffer.from("ÅÄÖåäö", "utf8"))).toBe(true);
      expect(ctx.wireBytes.toString("utf8")).toContain('"source": "ai:4"');
      expect(result.status).toBe(200);
      expect(result.requestHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(readFileSync(result.persistedBody).equals(ctx.wireBytes)).toBe(true);
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  component("adds only the bounded fleet identity header", {
    given: ["a staged request", () => {
      const ctx = fixture();
      ctx.fetchImpl = async (_url, options) => {
        ctx.headers = options.headers;
        return new Response("{}", { status: 200 });
      };
      return ctx;
    }],
    when: ["sending as one fleet pane", (ctx) => sendSuggestionsRequest({
      method: "POST", path: "/api/agent/check-in", bodyFile: ctx.bodyFile,
      token: "fleet-key", requestHeaders: { "x-agent-id": "skyvw:4" },
      stateDir: ctx.stateDir, fetchImpl: ctx.fetchImpl,
    })],
    then: ["authorization cannot be overridden while the pane header is preserved", (_result, ctx) => {
      expect(ctx.headers).toMatchObject({ authorization: "Bearer fleet-key",
        "x-agent-id": "skyvw:4" });
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  // AI-0026. The helper having tests proves the helper. This proves the SEND
  // PATH consults it: a body whose Swedish already lost every diacritic must
  // produce a counted warning on the way out, without blocking the send.
  component("warns on the way out when the body carries mangled Swedish", {
    given: ["a request body whose Swedish lost every diacritic when it was written", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-suggest-mangled-"));
      const bodyFile = join(root, "request.json");
      const reason = "Laget ar systemiskt, inte ticket-specifikt: ingen av "
        + "projektets tickets har state=approved eftersom gaten ar retroaktiv, och "
        + "watchdogen eskalerar anda, vilket gor att den larmar om arbete som ingen "
        + "agent kan starta. Det flyttar bara bordan till den som lases av larmet "
        + "utan att en enda ticket blir mojlig att paborja.";
      writeFileSync(bodyFile, `${JSON.stringify({ mutationId, reason }, null, 2)}\n`);
      return { root, bodyFile, stateDir: join(root, "outbox"), warnings: [] };
    }],
    when: ["sending it", async (ctx) => {
      await sendSuggestionsRequest({
        method: "PATCH",
        path: "/api/tickets/AI-0026/admin?project=ai",
        bodyFile: ctx.bodyFile,
        token: "test-token",
        stateDir: ctx.stateDir,
        warn: (message) => ctx.warnings.push(message),
        fetchImpl: async () => new Response("{}"),
      });
      return ctx;
    }],
    then: ["one counted warning was raised and the send still completed", (ctx) => {
      expect(ctx.warnings).toHaveLength(1);
      expect(ctx.warnings[0]).toContain("1 paragraph reads");
      expect(readFileSync(join(ctx.stateDir, `${mutationId}.json`), "utf8"))
        .toContain("acknowledged");
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  component("stays silent for the same text with its diacritics intact", {
    given: ["the identical body, correctly spelled", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-suggest-clean-"));
      const bodyFile = join(root, "request.json");
      const reason = "Läget är systemiskt, inte ticket-specifikt: ingen av "
        + "projektets tickets har state=approved eftersom gaten är retroaktiv, och "
        + "watchdogen eskalerar ändå, vilket gör att den larmar om arbete som ingen "
        + "agent kan starta. Det flyttar bara bördan till den som låses av larmet "
        + "utan att en enda ticket blir möjlig att påbörja.";
      writeFileSync(bodyFile, `${JSON.stringify({ mutationId, reason }, null, 2)}\n`);
      return { root, bodyFile, stateDir: join(root, "outbox"), warnings: [] };
    }],
    when: ["sending it", async (ctx) => {
      await sendSuggestionsRequest({
        method: "PATCH",
        path: "/api/tickets/AI-0026/admin?project=ai",
        bodyFile: ctx.bodyFile,
        token: "test-token",
        stateDir: ctx.stateDir,
        warn: (message) => ctx.warnings.push(message),
        fetchImpl: async () => new Response("{}"),
      });
      return ctx;
    }],
    then: ["nothing was warned about", (ctx) => {
      expect(ctx.warnings).toEqual([]);
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });
  unit("keeps a protocol handshake payload whole instead of severing it", {
    given: ["a 428 acknowledgement longer than the old 500-character cut", () => {
      const ack = JSON.stringify({ error: "policy-ack-required", currentBootstrap: {
        protocolVersion: "1.1.0", protocolHash: `sha256:${"a".repeat(64)}`,
        routingGuideHash: `sha256:${"b".repeat(64)}`, brokerOwner: "lsrc:2",
        allowedWorkerPanesHash: `sha256:${"c".repeat(64)}`,
        capabilityMatrixHash: `sha256:${"d".repeat(64)}`,
        resolvedPolicyHash: `sha256:${"e".repeat(64)}`,
      } });
      return { ack };
    }],
    when: ["formatting it as a rejection detail", ({ ack }) => failureDetail(ack)],
    then: ["it survives intact and still parses", (detail, { ack }) => {
      expect(detail.length).toBeGreaterThan(500);
      expect(detail).toBe(ack);
      expect(JSON.parse(detail).currentBootstrap.resolvedPolicyHash)
        .toBe(`sha256:${"e".repeat(64)}`);
    }],
  });

  unit("says so out loud when a body really is too large to keep", {
    given: ["a response far past the bound", () => ({ huge: "x".repeat(25_000) })],
    when: ["formatting it", ({ huge }) => failureDetail(huge)],
    then: ["the cut is announced with both numbers, never silent", (detail) => {
      expect(detail).toContain("[amux-suggest: response truncated at 20000 of 25000 characters]");
      expect(detail.startsWith("x".repeat(20_000))).toBe(true);
    }],
  });

  component("a rejected send records the whole acknowledgement in its envelope", {
    given: ["a server answering 428 with a long ack", () => {
      const ctx = fixture();
      ctx.ack = JSON.stringify({ error: "policy-ack-required",
        currentBootstrap: { filler: "f".repeat(900) } });
      return ctx;
    }],
    when: ["sending and reading the envelope back", async (ctx) => {
      await sendSuggestionsRequest({
        method: "PATCH",
        path: "/api/tickets/SRC-0086/assignment?project=source",
        bodyFile: ctx.bodyFile,
        token: "test-token",
        stateDir: ctx.stateDir,
        fetchImpl: async () => new Response(ctx.ack, { status: 428 }),
      }).catch((error) => { ctx.error = error; });
      const file = readdirSync(ctx.stateDir)
        .find((name) => name.endsWith(".json") && !name.endsWith(".body.json"));
      ctx.envelope = JSON.parse(readFileSync(join(ctx.stateDir, file), "utf8"));
      return ctx;
    }],
    then: ["the caller and the durable record both hold the echoable payload", (ctx) => {
      expect(ctx.envelope.state).toBe("rejected");
      expect(ctx.envelope.lastStatus).toBe(428);
      expect(JSON.parse(ctx.envelope.lastError).currentBootstrap.filler.length).toBe(900);
      expect(ctx.error.message).toContain("policy-ack-required");
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });
});
