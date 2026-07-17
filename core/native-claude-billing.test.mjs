import { describe, expect, it } from "vitest";
import {
  CLAUDE_API_BILLING_ENV,
  subscriptionSafeClaudeEnv,
} from "./native-claude-billing.mjs";

describe("native Claude billing boundary", () => {
  it("removes every API/provider override unless billing was explicitly opted in", () => {
    const source = Object.fromEntries(CLAUDE_API_BILLING_ENV.map((key) => [key, `secret-${key}`]));
    source.PATH = "/usr/bin";

    const result = subscriptionSafeClaudeEnv(source);

    for (const key of CLAUDE_API_BILLING_ENV) expect(result).not.toHaveProperty(key);
    expect(result).toMatchObject({
      PATH: "/usr/bin",
      AMUX_NATIVE_CLAUDE_BILLING_MODE: "subscription",
    });
    expect(source.ANTHROPIC_API_KEY).toBe("secret-ANTHROPIC_API_KEY");
  });

  it("preserves API auth only behind the explicit billing switch", () => {
    const result = subscriptionSafeClaudeEnv({
      ANTHROPIC_API_KEY: "explicit-key",
      AMUX_NATIVE_CLAUDE_ALLOW_API_BILLING: "true",
    });

    expect(result).toMatchObject({
      ANTHROPIC_API_KEY: "explicit-key",
      AMUX_NATIVE_CLAUDE_BILLING_MODE: "api-explicit",
    });
  });
});
