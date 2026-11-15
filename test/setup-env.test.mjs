import { feature, unit, expect } from "bdd-vitest";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { notifyUser } from "../cli/send-notify.mjs";

// On 2026-10-19 an integration test started the checkout's CLI under a
// temporary HOME with the shell's AGENTS_YAML, and the CLI regenerated the
// live channel map from the checkout's July agentmux.yaml.
feature("test isolation from the operator's runtime files", () => {
  unit("test environment prevents notification network calls", {
    when: ["a test requests a human notification", async () => {
      const fetchMock = vi.fn(async () => { throw new Error("network prevented by test mock"); });
      vi.stubGlobal("fetch", fetchMock);
      try { return { result: await notifyUser("test notification", { userId: "123", strictSingleAttempt: true }).catch(() => null), calls: fetchMock.mock.calls.length }; }
      finally { vi.unstubAllGlobals(); }
    }],
    then: ["it returns the test result without network", ({ result, calls }) => {
      expect(result).toMatchObject({ sent: false, target: "test" });
      expect(calls).toBe(0);
    }],
  });
  unit("every test process addresses only a temporary pane config and bridge state", {
    when: ["reading the paths a test and its child processes inherit", () => [process.env.AGENTS_YAML, process.env.STATE_FILE]],
    then: ["both lie in the temporary directory", (paths) => {
      for (const path of paths) expect(String(path).startsWith(`${tmpdir()}/`)).toBe(true);
    }],
  });
});
