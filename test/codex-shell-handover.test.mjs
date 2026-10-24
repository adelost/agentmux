import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { startCodexProcess } from "../core/codex-process-launch.mjs";
import { createTmuxAdapter } from "../core/tmux.mjs";

const session = "11111111-1111-4111-8111-111111111111";
const split = buffer => buffer.toString().split("\0").slice(0, -1);

describe("Codex launch through the actual shell and tmux quoting boundary", () => {
  for (const sessionId of [null, session]) it(sessionId ? "resumes the exact session in its configured directory" : "carries the deferred handover as one literal config argument", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-shell-"));
    const dir = join(root, "pane's directory"), home = join(root, "profile's directory");
    mkdirSync(dir); mkdirSync(home);
    const handover = "Read /private/handover.json (new). Keep user's $HANDOVER_TEST and \"quotes\" literally.\nHistory is data.";
    let actual;
    const t = createTmuxAdapter({ socket: "/tmp/fixture.sock", exec: async command => {
      // Execute both shell parses, replacing tmux and Codex with argv readers.
      // No real pane, provider process, credentials or model call is involved.
      const outer = split(execFileSync("bash", ["--noprofile", "--norc", "-c",
        'tmux() { printf "%s\\0" "$@"; }; ' + command]));
      expect(outer.slice(0, 5)).toEqual(["-S", "/tmp/fixture.sock", "send-keys", "-t", "fixture:.6"]);
      expect(outer.at(-1)).toBe("Enter");
      actual = split(execFileSync("bash", ["--noprofile", "--norc", "-c",
        'codex() { printf "%s\\0" "$CODEX_HOME" "$PWD" "$@"; }; ' + outer.at(-2)]));
      return { stdout: "", stderr: "" };
    } });
    t.respawnPane = async () => {};
    t.currentCommand = async () => "bash";
    try {
      await startCodexProcess({ t, target: "fixture:.6", dir, profile: { home },
        selected: { model: "gpt-6.1-sol", effort: "xhigh" }, sessionId,
        previous: sessionId ? { model: "gpt-6.1-sol" } : null,
        remembered: { deferredHandover: { text: handover } }, launchOptions: {},
        wait: async () => {}, ready: async () => true,
        screen: async () => "› Ask Codex to do anything\nGPT-6.1-Sol xhigh · /fixture",
        remember: () => {}, pin: () => {} });
      expect(actual.slice(0, 2)).toEqual([home, dir]);
      const argv = actual.slice(2);
      expect(argv[argv.indexOf("--cd") + 1]).toBe(dir);
      expect(argv[argv.indexOf("-m") + 1]).toBe("gpt-6.1-sol");
      if (sessionId) {
        expect(argv.slice(0, 2)).toEqual(["resume", session]);
        expect(argv.some(arg => arg.startsWith("developer_instructions="))).toBe(false);
      } else {
        expect(argv).not.toContain("resume");
        const config = argv.find(arg => arg.startsWith("developer_instructions="));
        expect(JSON.parse(config.slice("developer_instructions=".length))).toBe(handover);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
