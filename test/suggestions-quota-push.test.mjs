// Push-script contracts: config errors are loud and the log line names
// exactly which engine data made it into the pushed snapshot.

import { feature, unit, expect } from "bdd-vitest";
import { loadPushConfig, quotaPushSummary } from "../bin/suggestions-quota-push.mjs";

feature("suggestions-quota-push config", () => {
  unit("parses baseUrl and expands the credential path", {
    when: ["loading a complete config", () => loadPushConfig(
      "baseUrl: https://suggest.v1d.io/\nadminCredentialFile: ~/.config/agent/suggestions-admin-token\n",
    )],
    then: ["the trailing slash is stripped and ~ resolves to home", (config) => {
      expect(config.baseUrl).toBe("https://suggest.v1d.io");
      expect(config.credentialFile.startsWith("/")).toBe(true);
      expect(config.credentialFile.endsWith(".config/agent/suggestions-admin-token")).toBe(true);
    }],
  });

  unit("a config without required keys fails loudly", {
    when: ["loading a config missing adminCredentialFile", () => {
      try {
        loadPushConfig("baseUrl: https://suggest.v1d.io\n");
        return "no error";
      } catch (error) {
        return error.message;
      }
    }],
    then: ["the error names both required keys", (message) => {
      expect(message).toContain("baseUrl and adminCredentialFile");
    }],
  });
});

feature("suggestions-quota-push summary", () => {
  unit("names per-engine outcome including typed errors", {
    when: ["summarizing a mixed snapshot", () => quotaPushSummary({
      claude: { ok: true, limits: [] },
      codex: { ok: false, error: "no_rate_limit_events" },
    })],
    then: ["both engines and the codex error are visible", (summary) => {
      expect(summary).toContain("claude ok");
      expect(summary).toContain("codex no_rate_limit_events");
    }],
  });
});
