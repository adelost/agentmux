import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GEMINI_FORBIDDEN_ENV } from "./gemini-launch.mjs";

const script = fileURLToPath(new URL("../bin/gemini-hook.mjs", import.meta.url));
const sessionId = "11111111-1111-4111-8111-111111111111";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-gemini-hooks-"));
  const events = join(root, "events-g1.jsonl");
  writeFileSync(events, "");
  return { root, events, env: {
    PATH: "/bin", HOME: root, AMUX_GEMINI_EVENTS: events,
    AMUX_GEMINI_SESSION_ID: sessionId, AMUX_GEMINI_GENERATION: "g1", AMUX_GEMINI_CWD: root,
  } };
}

feature("Gemini generation-bound hooks", () => {
  component("all lifecycle hooks append intact UTF-8 receipts for only this generation", {
    given: ["an isolated generation events file", fixture],
    when: ["the CLI invokes four real hook subprocesses", ctx => {
      for (const hook of ["SessionStart", "BeforeAgent", "AfterAgent", "SessionEnd"]) {
        execFileSync(process.execPath, [script], {
          env: ctx.env, input: JSON.stringify({ hook_event_name: hook, session_id: sessionId,
            cwd: ctx.root, transcript_path: join(ctx.root, "session.jsonl"), prompt: "Hej åäö", prompt_response: "Svar 🤍" }),
        });
      }
      return readFileSync(ctx.events, "utf8").trim().split("\n").map(JSON.parse);
    }],
    then: ["each receipt carries the exact session/generation and payload", records => {
      expect(records.map(record => record.hook_event_name)).toEqual(["SessionStart", "BeforeAgent", "AfterAgent", "SessionEnd"]);
      expect(records.every(record => record.session_id === sessionId && record.generation === "g1")).toBe(true);
      expect(records[1].prompt).toBe("Hej åäö");
      expect(records[2].prompt_response).toBe("Svar 🤍");
      expect(records[0].environment).toEqual(Object.fromEntries(GEMINI_FORBIDDEN_ENV.map(name => [name, false])));
    }],
    cleanup: ctx => rmSync(ctx.root, { recursive: true, force: true }),
  });

  component("SessionStart records only presence booleans for an effective auth variable", {
    given: ["a child that acquired a synthetic key after launch", () => {
      const ctx = fixture();
      ctx.env.GEMINI_API_KEY = "synthetic-secret-not-for-the-record";
      return ctx;
    }],
    when: ["the real SessionStart script inspects its inherited environment", ctx => {
      execFileSync(process.execPath, [script], { env: ctx.env, input: JSON.stringify({
        hook_event_name: "SessionStart", session_id: sessionId, cwd: ctx.root,
      }) });
      return readFileSync(ctx.events, "utf8");
    }],
    then: ["the key is detectable without disclosing its value", raw => {
      expect(JSON.parse(raw).environment.GEMINI_API_KEY).toBe(true);
      expect(raw).not.toContain("synthetic-secret-not-for-the-record");
    }],
    cleanup: ctx => rmSync(ctx.root, { recursive: true, force: true }),
  });

  for (const change of ["foreign-session", "foreign-cwd", "unknown-hook", "missing-binding", "malformed"]) {
    component(`${change} cannot append a receipt`, {
      given: ["an isolated bound hook", fixture],
      when: ["an invalid invocation reaches the hook boundary", ctx => {
        const input = { hook_event_name: "BeforeAgent", session_id: sessionId, cwd: ctx.root, prompt: "not accepted" };
        if (change === "foreign-session") input.session_id = "22222222-2222-4222-8222-222222222222";
        if (change === "foreign-cwd") input.cwd = "/another-pane";
        if (change === "unknown-hook") input.hook_event_name = "BeforeTool";
        if (change === "missing-binding") delete ctx.env.AMUX_GEMINI_GENERATION;
        return spawnSync(process.execPath, [script], { env: ctx.env,
          input: change === "malformed" ? "{" : JSON.stringify(input) });
      }],
      then: ["the hook fails without writing the prompt", (result, ctx) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr.toString()).toContain("GEMINI_HOOK_REJECTED:");
        expect(readFileSync(ctx.events, "utf8")).toBe("");
      }],
      cleanup: ctx => rmSync(ctx.root, { recursive: true, force: true }),
    });
  }
});
