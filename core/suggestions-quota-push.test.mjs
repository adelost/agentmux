import { component, expect, feature } from "bdd-vitest";
import { vi } from "vitest";
import { pushSuggestionsQuota } from "../bin/suggestions-quota-push.mjs";

feature("Suggestions quota push shared load boundary", () => {
  component("the third cron uses the shared client and requires the exact 204 receipt", {
    given: ["a quota snapshot and an injected Suggestions HTTP client", () => ({
      config: { baseUrl: "https://suggest.v1d.io" },
      token: "a".repeat(40),
      snapshot: {
        capturedAt: "2026-07-15T12:00:00.000Z",
        claude: { ok: false, error: "missing" },
        codex: { ok: false, error: "missing" },
      },
      httpClient: { requestJson: vi.fn(async () => null) },
    })],
    when: ["pushing through the cron seam", (ctx) => pushSuggestionsQuota(ctx)],
    then: ["the client owns auth, timeout, body and exact status validation", (summary, ctx) => {
      expect(summary).toContain("pushed quota snapshot");
      expect(ctx.httpClient.requestJson).toHaveBeenCalledWith(
        "https://suggest.v1d.io/api/ops/quota",
        expect.objectContaining({
          token: ctx.token,
          method: "POST",
          expectedStatus: 204,
          body: { version: 1, snapshot: ctx.snapshot },
        }),
      );
    }],
  });
});
