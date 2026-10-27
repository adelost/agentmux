import { component, expect, feature } from "bdd-vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEMINI_FORBIDDEN_ENV } from "./gemini-launch.mjs";
import { latestGeminiSessionIdentity, prepareGeminiRuntimeFiles, publishGeminiRuntime } from "./gemini-pane-files.mjs";

const sessionId = "11111111-1111-4111-8111-111111111111";
const line = value => `${JSON.stringify(value)}\n`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-gemini-files-"));
  const paneDir = join(root, "repo with spaces", ".agents", "4");
  const options = { stateRoot: join(root, "state") };
  const files = prepareGeminiRuntimeFiles(paneDir, { ...options, sessionId,
    profileHome: join(root, "profile"), generation: "g1" });
  const start = { hook_event_name: "SessionStart", session_id: sessionId, generation: "g1", cwd: paneDir,
    transcript_path: join(root, "profile", ".gemini", "tmp", "repo", "chats", "session-2026-10-27T18-15-11111111.jsonl"),
    environment: Object.fromEntries(GEMINI_FORBIDDEN_ENV.map(name => [name, false])) };
  return { root, paneDir, options, files, start };
}
const cleanup = ctx => rmSync(ctx.root, { recursive: true, force: true });

feature("Gemini durable continuity and startup attestation", () => {
  component("the intended exact session survives a crash before publication", {
    given: ["prepared private generation files without a running process", fixture],
    when: ["recovery reads its pending startup intent", ctx => latestGeminiSessionIdentity(ctx.paneDir, { ...ctx.options, strict: true })],
    then: ["recovery resumes that UUID rather than bootstrapping another", (identity, ctx) => {
      expect(identity).toMatchObject({ sessionId, generation: "g1", profileHome: ctx.files.profileHome });
      expect(statSync(ctx.files.root).mode & 0o777).toBe(0o700);
      expect(statSync(ctx.files.eventsPath).mode & 0o777).toBe(0o600);
    }], cleanup,
  });

  component("a clean exact SessionStart publishes before the native journal's first write", {
    given: ["a prepared generation and a not-yet-created transcript", fixture],
    when: ["the real hook shape is appended and published", ctx => {
      appendFileSync(ctx.files.eventsPath, line(ctx.start));
      return publishGeminiRuntime(ctx.files);
    }],
    then: ["the published path and UUID bind the same pane", (identity, ctx) => {
      expect(identity).toMatchObject({ sessionId, generation: "g1", path: ctx.start.transcript_path });
      expect(latestGeminiSessionIdentity(ctx.paneDir, ctx.options)).toMatchObject(identity);
    }], cleanup,
  });

  for (const problem of ["dirty-environment", "missing-environment", "foreign-session", "foreign-generation", "foreign-cwd", "unsafe-transcript"]) {
    component(`${problem} cannot publish a ready process`, {
      given: ["a prepared but untrusted startup receipt", fixture],
      when: ["publication checks the receipt", ctx => {
        if (problem === "dirty-environment") ctx.start.environment.GOOGLE_API_KEY = true;
        if (problem === "missing-environment") delete ctx.start.environment;
        if (problem === "foreign-session") ctx.start.session_id = "22222222-2222-4222-8222-222222222222";
        if (problem === "foreign-generation") ctx.start.generation = "old";
        if (problem === "foreign-cwd") ctx.start.cwd = "/other-pane";
        if (problem === "unsafe-transcript") ctx.start.transcript_path = join(ctx.files.profileHome, ".gemini", "oauth_creds.json");
        appendFileSync(ctx.files.eventsPath, line(ctx.start));
        return () => publishGeminiRuntime(ctx.files);
      }],
      then: ["the process is not admitted for delivery", (publish, ctx) => {
        expect(publish).toThrow(/Gemini startup refused/u);
        expect(latestGeminiSessionIdentity(ctx.paneDir, ctx.options)).toBeNull();
      }], cleanup,
    });
  }

  component("corrupt existing metadata blocks recovery instead of becoming a fresh session", {
    given: ["a successfully published generation", () => {
      const ctx = fixture();
      appendFileSync(ctx.files.eventsPath, line(ctx.start));
      publishGeminiRuntime(ctx.files);
      writeFileSync(join(ctx.files.root, "runtime.json"), "{incomplete");
      return ctx;
    }],
    when: ["a lifecycle boundary reads strict continuity", ctx => () => latestGeminiSessionIdentity(ctx.paneDir, { ...ctx.options, strict: true })],
    then: ["ambiguity is preserved for inspection", check => expect(check).toThrow(/continuity blocked/u)], cleanup,
  });

  component("metadata cannot redirect a reader to another generation's events", {
    given: ["a valid runtime with its saved event path tampered", () => {
      const ctx = fixture();
      appendFileSync(ctx.files.eventsPath, line(ctx.start));
      publishGeminiRuntime(ctx.files);
      const path = join(ctx.files.root, "runtime.json");
      const saved = JSON.parse(readFileSync(path, "utf8"));
      saved.eventsPath = join(ctx.files.root, "events-other.jsonl");
      writeFileSync(path, JSON.stringify(saved));
      return ctx;
    }],
    when: ["a lifecycle boundary reads strict continuity", ctx => () => latestGeminiSessionIdentity(ctx.paneDir, { ...ctx.options, strict: true })],
    then: ["the mismatched path is refused", check => expect(check).toThrow(/continuity blocked/u)], cleanup,
  });
});
