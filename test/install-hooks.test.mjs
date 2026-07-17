import { expect, feature, integration } from "bdd-vitest";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

feature("agentmux hook installer", () => {
  integration("installs one blocking Suggestions authoring guard without removing other hooks", {
    given: ["a settings file with an unrelated Bash hook and a stale amux guard", () => {
      const home = mkdtempSync(join(tmpdir(), "amux-install-hooks-"));
      const claude = join(home, ".claude");
      mkdirSync(claude, { recursive: true });
      writeFileSync(join(claude, "settings.json"), `${JSON.stringify({ hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "keep-me" }] },
          { matcher: "Bash", hooks: [{ type: "command",
            command: "node /stale/suggestions-write-guard.mjs" }] },
        ],
      } }, null, 2)}\n`);
      return home;
    }],
    when: ["installing the hook update twice", (home) => ({
      home,
      results: [0, 1].map(() => spawnSync(
        process.execPath,
        [resolve("bin/install-hooks.mjs")],
        { encoding: "utf8", env: { ...process.env, HOME: home } },
      )),
    })],
    then: ["the guard is singular, stable, and the existing hook survives", ({ home, results }) => {
      expect(results.map((result) => result.status)).toEqual([0, 0]);
      const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
      const commands = settings.hooks.PreToolUse.flatMap((row) => row.hooks)
        .map((hook) => hook.command);
      expect(commands).toContain("keep-me");
      expect(commands.filter((command) => command.includes("suggestions-write-guard.mjs")))
        .toHaveLength(1);
      expect(settings.hooks.PreToolUse.find((row) => row.hooks.some(
        (hook) => hook.command.includes("suggestions-write-guard.mjs"),
      )).matcher).toBe("Bash");
      const installed = join(home, ".agentmux", "bin", "amux-suggest.mjs");
      const linked = join(home, ".local", "bin", "amux-suggest");
      expect(existsSync(installed)).toBe(true);
      expect(resolve(join(linked, ".."), readlinkSync(linked))).toBe(installed);
      rmSync(home, { recursive: true, force: true });
    }],
  });
});
