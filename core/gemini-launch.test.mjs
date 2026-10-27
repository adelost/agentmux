import { feature, unit, expect } from "bdd-vitest";
import { execFileSync } from "node:child_process";
import {
  GEMINI_FORBIDDEN_ENV,
  assertGeminiStartPolicy,
  buildGeminiLaunchCommand,
  geminiChildEnvironment,
  geminiProfileHome,
} from "./gemini-launch.mjs";

const sessionId = "11111111-1111-4111-8111-111111111111";
const profileHome = "/profiles/gemini/login";
const settings = { security: { auth: { selectedType: "oauth-personal" } }, advanced: { ignoreLocalEnv: true } };
const launch = (extra = {}) => buildGeminiLaunchCommand({
  executable: "/usr/bin/gemini", profileHome, sessionId,
  allowFreshBootstrap: true, ...extra,
});

feature("Gemini subscription-only launch", () => {
  unit("only an explicit Google profile below the Gemini profile root is selected", {
    when: ["resolving named, missing and escaping profiles", () => ({
      valid: geminiProfileHome("login", "/profiles/gemini"),
      missing: () => geminiProfileHome(null, "/profiles/gemini"),
      escape: () => geminiProfileHome("../claude/login", "/profiles/gemini"),
    })],
    then: ["no primary-home or traversal fallback is possible", ({ valid, missing, escape }) => {
      expect(valid).toBe(profileHome);
      expect(missing).toThrow(/explicit Gemini profile/u);
      expect(escape).toThrow(/invalid Gemini profile/u);
    }],
  });

  unit("an API-key profile is refused before a Gemini process starts", {
    when: ["checking the selected authentication method", () => () => assertGeminiStartPolicy({
      profileHome, settings: { security: { auth: { selectedType: "gemini-api-key" } } }, env: {},
    })],
    then: ["only oauth-personal is admitted", (check) => expect(check).toThrow(/oauth-personal/u)],
  });

  unit("missing or conflicting authentication never silently falls back", {
    when: ["checking missing and conflicting settings", () => [
      {}, { security: { auth: { selectedType: "oauth-personal", enforcedType: "vertex-ai" } } },
    ].map(value => () => assertGeminiStartPolicy({ profileHome, settings: value, env: {} }))],
    then: ["both profiles refuse startup", (checks) => checks.forEach(check => expect(check).toThrow(/oauth-personal/u))],
  });

  unit("the effective child environment refuses every paid-auth override, even an empty one", {
    when: ["checking each forbidden variable independently", () => GEMINI_FORBIDDEN_ENV.map(name => ({
      name, check: () => assertGeminiStartPolicy({ profileHome, settings, env: { [name]: "" } }),
    }))],
    then: ["all forbidden variables fail closed without revealing their values", (checks) => {
      expect(checks.length).toBeGreaterThanOrEqual(7);
      checks.forEach(({ name, check }) => expect(check).toThrow(name));
    }],
  });

  unit("sanitizing preserves ordinary environment without mutating its input", {
    when: ["building the launch environment", () => {
      const original = { PATH: "/bin", GEMINI_API_KEY: "synthetic-do-not-print", GEMINI_CLI_AUTH_OVERRIDE: "vertex-ai" };
      return { original, clean: geminiChildEnvironment(original) };
    }],
    then: ["only the child loses forbidden variables", ({ original, clean }) => {
      expect(clean).toEqual({ PATH: "/bin" });
      expect(Object.hasOwn(original, "GEMINI_API_KEY")).toBe(true);
      expect(assertGeminiStartPolicy({ profileHome, settings, env: clean })).toEqual({ ok: true });
    }],
  });

  unit("dotenv loading cannot silently reintroduce removed keys", {
    when: ["checking a profile without the supported environment guard", () => () => assertGeminiStartPolicy({
      profileHome, settings: { security: settings.security }, env: {},
    })],
    then: ["startup refuses an unguarded environment", check => expect(check).toThrow(/ignoreLocalEnv/u)],
  });

  unit("a fresh launch pins a UUID, Google home and yolo without choosing an Auto model", {
    when: ["building a first launch", () => launch()],
    then: ["the command scrubs all paid-auth inputs and disables env loading", (command) => {
      expect(command).toContain(`--session-id '${sessionId}'`);
      expect(command).toContain("GEMINI_CLI_HOME='/profiles/gemini/login'");
      expect(command).toContain("--approval-mode yolo");
      expect(command).toContain("--skip-trust");
      expect(command).not.toContain("--ignore-env");
      GEMINI_FORBIDDEN_ENV.forEach(name => expect(command).toContain(`-u ${name}`));
      expect(command).not.toMatch(/(?:^|\s)(?:-m|--model|--resume)\s/u);
    }],
  });

  unit("resume uses only the exact UUID and an explicit model when requested", {
    when: ["building an exact restart", () => launch({ resume: true, model: "gemini-3.5-pro" })],
    then: ["resume never becomes latest or a new session", (command) => {
      expect(command).toContain(`--resume '${sessionId}'`);
      expect(command).toContain("-m 'gemini-3.5-pro'");
      expect(command).not.toContain("--session-id");
    }],
  });

  unit("ambiguous continuity, unauthorized bootstrap and unsafe model arguments are refused", {
    when: ["building invalid launch requests", () => [
      () => launch({ sessionId: "latest" }),
      () => launch({ allowFreshBootstrap: false }),
      () => launch({ model: "auto; touch /tmp/not-allowed" }),
    ]],
    then: ["each request fails before launch", (checks) => checks.forEach(check => expect(check).toThrow())],
  });

  unit("shell arguments retain spaces, quotes and literal dollar syntax", {
    when: ["running the built command against a harmless argv recorder instead of Gemini", () => {
      const command = launch({ executable: "/usr/bin/printf", profileHome: "/profiles/gemini/o'neil $literal" });
      return execFileSync("/bin/sh", ["-c", command.replace("'/usr/bin/printf'", "'/usr/bin/printf' '%s\\n'")], {
        encoding: "utf8", env: { PATH: "/bin", GEMINI_API_KEY: "fixture" },
      });
    }],
    then: ["the continuity argv arrives intact", (output) => expect(output.split("\n")).toEqual([
      "--session-id", sessionId, "--approval-mode", "yolo", "--skip-trust", "",
    ])],
  });
});
