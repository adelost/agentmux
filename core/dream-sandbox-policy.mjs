import { resolve } from "node:path";
import { renderShellArgs } from "./execution-safety.mjs";

const toml = value => value && typeof value === "object"
  ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(",")}}`
  : JSON.stringify(value);

/** WHAT: Builds one OS-enforced curator profile. WHY: Keeps ordinary pane permissions from becoming Dream's memory authority. */
export function dreamSandboxConfig(guard) {
  if (!/^amux_dream_[a-z0-9_]+$/u.test(guard?.profile || "") || resolve(guard.root || "") !== guard.root) throw Error("dream-sandbox-invalid-scope");
  return [`default_permissions=${JSON.stringify(guard.profile)}`,
    `permissions.${guard.profile}=${toml({ filesystem: { ":root": "read", [guard.root]: "write" }, network: { enabled: false } })}`,
    "mcp_servers={}"];
}

/** WHAT: Builds restricted tool flags for the existing Codex session. WHY: Prevents escalation, external tool servers or inherited yolo flags from bypassing the OS boundary. */
export function dreamSandboxFlags(guard) {
  return renderShellArgs(["--no-daemon", "-a", "never", "--disable", "goals", "--disable", "multi_agent", "--disable", "apps", "--disable", "plugins",
    ...dreamSandboxConfig(guard).flatMap(value => ["-c", value])]);
}

/** WHAT: Checks controller startup evidence against this immutable input. WHY: Prevents a result file from attesting its own sandbox or borrowing another run's launch. */
export function verifyDreamSandboxProof(input, proof) {
  const expected = input.sandbox;
  if (!expected || !proof || !["running", "terminal"].includes(proof.status)
    || proof.runId !== input.runId || proof.inputSha256 !== input.sha256
    || proof.root !== expected.root || proof.profile !== expected.profile || !proof.sessionId) throw Error("dream-sandbox-unattested");
  dreamSandboxConfig(expected);
  return proof;
}
