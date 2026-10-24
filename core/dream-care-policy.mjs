// WHAT: Configures one fixed native permission surface for existing curator panes.
// WHY: Ordinary file care needs a lasting write boundary, not a per-run startup state machine.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { esc } from "../lib.mjs";
import { renderShellArgs } from "./execution-safety.mjs";
import { assertDreamWritePath, readDreamRegular } from "./dream-memory-effects.mjs";
import { writeDreamAtomic } from "./dream-commit.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const marker = cwd => join(cwd, ".amux-native-policy.json");
const seccomp = join(dirname(process.execPath), "../lib/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp", process.arch, "apply-seccomp");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

/** WHAT: Routes restricted startup through literal tmux input. WHY: Prevents legacy runShell from stripping empty arguments and JSON quotes. */
export async function runDreamCareCommand(tmux, target, cwd, command) {
  if (!readDreamCarePolicy(cwd)) return false;
  await tmux.sendLiteral(target, `cd '${esc(cwd)}' && ${command}`);
  await tmux.sendKeys(target, "Enter");
  return true;
}

/** WHAT: Reads the fixed pane policy without creating it. WHY: Prevents malformed policy from widening a restricted pane. */
export function readDreamCarePolicy(cwd) {
  if (!cwd || !existsSync(marker(cwd))) return null;
  assertDreamWritePath(marker(cwd));
  const policy = JSON.parse(readDreamRegular(marker(cwd), 16 * 1024));
  if (policy.version !== 1 || policy.engine !== "claude"
    || !policy.root || resolve(policy.root) !== policy.root || !policy.settingsPath || resolve(policy.settingsPath) !== policy.settingsPath
    || hash(readDreamRegular(policy.settingsPath, 32 * 1024)) !== policy.settingsSha256) throw Error("dream-care-policy-invalid");
  return policy;
}

/** WHAT: Returns native flags only for an explicitly configured fixed workspace. WHY: Ordinary product panes keep their existing launch contract. */
export function dreamCareNativeFlags(engine, cwd) {
  const policy = readDreamCarePolicy(cwd);
  if (!policy) return null;
  if (policy.engine !== engine) throw Error("dream-care-policy-engine-mismatch");
  return renderShellArgs(["--permission-mode", "dontAsk", "--setting-sources", "", "--settings", policy.settingsPath,
    "--tools", "Bash,Read,Edit,Write,Glob,Grep", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']);
}

/** WHAT: Stores static settings for already configured curators. WHY: Keeps source, credentials and receipts outside the model-writable directories. */
export function configureDreamCare(owners, { root = join(homedir(), ".local/share/agentmux/dream-care"), reference = "memory/references/memory-flow.md" } = {}) {
  if (owners.some(owner => owner.engine !== "claude")) throw Error("dream-care-setup-engine-unqualified: only the existing Claude curator is qualified for this slice");
  root = resolve(root);
  for (const path of [join(root, "worktree"), join(root, "outbox"), join(root, "controller")]) {
    assertDreamWritePath(join(path, "placeholder")); mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  if (!/^memory\/references\/[a-z0-9-]+\.md$/u.test(reference)) throw Error("dream-care-reference-invalid");
  return owners.map(owner => {
    const home = homedir(), worktree = join(root, "worktree"), outbox = join(root, "outbox");
    const credentials = [".claude", ".codex", ".ssh", ".aws", ".env", ".npmrc", ".docker/config.json", ".config/agent", ".openclaw/openclaw.json", ".agentmux/.env", ".agentmux/keys"].map(path => join(home, path));
    const settings = { permissions: { defaultMode: "dontAsk", disableBypassPermissionsMode: "disable", disableAutoMode: "disable",
      allow: ["Read", "Glob", "Grep", "Bash", `Edit(/${worktree}/MEMORY.md)`, `Edit(/${worktree}/memory/references/**)`, `Edit(/${outbox}/**)`],
      deny: [...credentials.flatMap(path => [`Read(/${path})`, `Read(/${path}/**)`]), `Edit(/${worktree}/.git)`, `Edit(/${worktree}/.git/**)`, `Edit(/${worktree}/.claude/**)`, "Agent", "WebFetch", "WebSearch"] },
      sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
        filesystem: { allowWrite: [worktree, outbox], denyWrite: ["/tmp", "/var/tmp", "/dev/shm", owner.paneDir, join(root, "controller"), join(root, "repo"), join(worktree, ".git"), join(worktree, ".claude")], denyRead: credentials },
        network: { allowedDomains: [], allowUnixSockets: [] } },
      env: { CLAUDE_CODE_TMPDIR: join(outbox, "tmp") },
      statusLine: { type: "command", command: "amux-claude-statusline" }, hooks: {}, autoMemoryEnabled: false, disableAllHooks: false, enableAllProjectMcpServers: false };
    const settingsPath = join(root, "controller", `${owner.engine}-${owner.agent}-${owner.pane}.json`);
    let bytes = JSON.stringify(settings, null, 2) + "\n";
    if (existsSync(settingsPath)) {
      const previous = readDreamRegular(settingsPath, 32 * 1024).toString("utf8");
      if (JSON.stringify(canonical(JSON.parse(previous))) !== JSON.stringify(canonical(settings))) throw Error("dream-care-settings-conflict");
      bytes = previous;
    }
    assertDreamWritePath(settingsPath); writeDreamAtomic(settingsPath, bytes, { immutable: true }); chmodSync(settingsPath, 0o400);
    const policy = { version: 1, engine: owner.engine, root, reference, settingsPath, settingsSha256: hash(bytes) };
    mkdirSync(owner.paneDir, { recursive: true, mode: 0o700 }); assertDreamWritePath(marker(owner.paneDir));
    writeDreamAtomic(marker(owner.paneDir), JSON.stringify(policy) + "\n", { immutable: true }); chmodSync(marker(owner.paneDir), 0o400);
    return { agent: owner.agent, pane: owner.pane, ...policy };
  });
}

/** WHAT: Checks the actual process carries the fixed policy. WHY: Prevents an unrestricted process from attesting isolation merely by reading settings. */
export async function verifyDreamCareRuntime(ctx, owner) {
  if (process.platform === "linux" && !existsSync(seccomp)) throw Error("dream-care-seccomp-missing: install the sandbox runtime under the current Node prefix");
  const policy = readDreamCarePolicy(owner.paneDir);
  if (!policy) throw Error("dream-care-policy-missing");
  const target = `${owner.agent}:.${owner.pane}`;
  if (!/^[a-zA-Z0-9_-]+:\.\d+$/u.test(target)) throw Error("dream-care-target-invalid");
  const { stdout } = await ctx.tmux(`display-message -p -t '${target}' '#{pane_pid}'`);
  const pending = [Number(stdout.trim())], seen = new Set();
  while (pending.length) {
    const pid = pending.shift(); if (!pid || seen.has(pid) || seen.size > 100) continue; seen.add(pid);
    let args;
    try {
      args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      pending.push(...readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/u).map(Number));
    } catch { continue; }
    if (owner.engine === "claude" && args.includes("--settings") && args.includes(policy.settingsPath)
      && args[args.indexOf("--permission-mode") + 1] === "dontAsk" && !args.includes("--dangerously-skip-permissions")) return { ...policy, verifiedPid: pid, verifiedAt: new Date().toISOString() };
  }
  throw Error("dream-care-unrestricted-process: restart the idle configured curator through its normal exact-session path");
}
