import { feature, unit, expect } from "bdd-vitest";
import { tmpdir } from "node:os";

// On 2026-10-19 an integration test started the checkout's CLI under a
// temporary HOME with the shell's AGENTS_YAML, and the CLI regenerated the
// live channel map from the checkout's July agentmux.yaml.
feature("test isolation from the operator's runtime files", () => {
  unit("every test process addresses only a temporary pane config and bridge state", {
    when: ["reading the paths a test and its child processes inherit", () => [process.env.AGENTS_YAML, process.env.STATE_FILE]],
    then: ["both lie in the temporary directory", (paths) => {
      for (const path of paths) expect(String(path).startsWith(`${tmpdir()}/`)).toBe(true);
    }],
  });
});
