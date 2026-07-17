// Subscription-safe environment policy for native Claude processes.

/** WHAT: Carries Claude API billing overrides. WHY: Prevents incomplete subscription-env scrubbing. */
export const CLAUDE_API_BILLING_ENV = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
]);

/**
 * WHAT: Builds the environment for one native Claude child.
 * WHY: Prevents inherited API credentials from changing the billing surface.
 */
export function subscriptionSafeClaudeEnv(source = process.env) {
  const env = { ...source };
  const allowApiBilling = env.AMUX_NATIVE_CLAUDE_ALLOW_API_BILLING === "true";
  if (!allowApiBilling) {
    for (const key of CLAUDE_API_BILLING_ENV) delete env[key];
    env.AMUX_NATIVE_CLAUDE_BILLING_MODE = "subscription";
  } else {
    env.AMUX_NATIVE_CLAUDE_BILLING_MODE = "api-explicit";
  }
  return env;
}
