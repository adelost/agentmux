import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { component, expect, feature } from "bdd-vitest";

const CLI = join(import.meta.dirname, "..", "bin", "agent-cli.mjs");

feature("amux compact --self on the command line", () => {
  component("--self reaches the self-request, not the agent lookup", {
    when: ["running it outside any pane", () => {
      const env = { ...process.env };
      for (const name of ["TMUX", "TMUX_PANE", "AMUX_AGENT_NAME", "AMUX_PANE"]) delete env[name];
      return spawnSync(process.execPath, [CLI, "compact", "--self", "-m", "keep the numbers"], { env, encoding: "utf8", timeout: 20_000 });
    }],
    then: ["it asks for a pane identity instead of an agent named --self", (run) => {
      const output = `${run.stdout}${run.stderr}`;
      expect(output).not.toContain("Unknown agent '--self'");
      expect(output).toContain("amux compact --self runs inside an amux pane");
    }],
  });
});
