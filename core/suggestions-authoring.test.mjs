import { component, expect, feature, unit } from "bdd-vitest";
import {
  mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  inspectSuggestionsMutationCommand, sendSuggestionsRequest,
} from "./suggestions-authoring.mjs";

const mutationId = "11111111-1111-4111-8111-111111111111";
const exactQuote = "Tycker färgborder här är lite för diskret — behåll ÅÄÖåäö exakt.";

const fixture = (comment = exactQuote) => {
  const root = mkdtempSync(join(tmpdir(), "amux-suggest-unicode-"));
  const bodyFile = join(root, "request.json");
  const expectFile = join(root, "quote.txt");
  const stateDir = join(root, "outbox");
  writeFileSync(bodyFile, `${JSON.stringify({ mutationId, source: "ai:4", comment }, null, 2)}\n`);
  writeFileSync(expectFile, exactQuote);
  return { root, bodyFile, expectFile, stateDir };
};

feature("Suggestions authoring boundary", () => {
  unit("blocks the reproduced inline Python mutation before HTTP", {
    when: ["inspecting the AI-0008 heredoc shape", () => inspectSuggestionsMutationCommand(`
python3 - <<'PY'
body={"comment":"modell-omladdning pa delade 3090:an, vilket kraver ett GPU-fonster"}
urllib.request.Request("https://suggest.v1d.io/api/tickets/AI-0008/admin?project=ai",
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
        "curl 'https://suggest.v1d.io/api/tickets/AI-0014?project=ai'",
      ),
      client: inspectSuggestionsMutationCommand(
        "amux-suggest --method PATCH --base-url https://suggest.v1d.io --path /api/tickets/AI-0014/admin --body-file /tmp/body.json",
      ),
    })],
    then: ["neither is denied", ({ read, client }) => {
      expect(read.blocked).toBe(false);
      expect(client.blocked).toBe(false);
    }],
  });

  unit("the installed hook turns the reproduced finding into a hard denial", {
    when: ["running the hook with a direct mutation", () => spawnSync(
      process.execPath,
      [resolve("bin/suggestions-write-guard.mjs")],
      {
        encoding: "utf8",
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "curl -X PATCH https://suggest.v1d.io/api/tickets/AI-0014/admin -d @body.json" },
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
});
