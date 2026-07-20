// Non-destructive WSL restart inventory and receipt writer.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { listAgents } from "./config.mjs";
import { readLastTurns } from "../core/jsonl-reader.mjs";
import { readLastTurnsCodex } from "../core/codex-jsonl-reader.mjs";
import { readLastTurnsKimi } from "../core/kimi-jsonl-reader.mjs";
import {
  needsDeliveryTerminalNotice,
  TERMINAL_DELIVERY_STATES,
} from "../core/delivery-queue.mjs";
import { identityDecision, observeReleaseIdentity } from "../core/release-identity.mjs";
import {
  buildRestartReadiness,
  verifyRestartReadyReceipt,
} from "../core/restart-ready.mjs";

const RECEIPT_ID = /^[0-9a-f]{32}$/u;
const TAIL_BYTES = 8 * 1024 * 1024;

/** WHAT: Resolves one configured pane engine. WHY: Keeps restart inventory limited to stateful coding runtimes. */
export function restartPaneEngine(pane = {}) {
  if (["claude", "codex", "kimi"].includes(pane.engine)) return pane.engine;
  const match = String(pane.cmd || "").match(/(?:^|[/\s])(claude|codex|kimi(?:-code)?)(?:\s|$)/u);
  if (!match) return null;
  return match[1].startsWith("kimi") ? "kimi" : match[1];
}

/** WHAT: Maps one journal tail to restart safety. WHY: Prevents screen-idle guesses from authorizing shutdown. */
export function panelRestartState(turns) {
  const latest = turns?.at(-1);
  if (!latest) return { state: "unknown", reason: "journal-missing" };
  if (latest.isComplete === true) return { state: "idle", reason: "turn-complete" };
  if (latest.isComplete === false) return { state: "active", reason: "turn-incomplete" };
  return { state: "unknown", reason: "completion-unclassified" };
}

/** WHAT: Maps native history to restart safety. WHY: Prevents a resident native process from being mistaken for an active turn. */
export function nativePanelRestartState(events = []) {
  let latestUser = null;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === "web" && event.subtype === "user") {
      latestUser = { index, operationKey: event.operationKey || null };
      break;
    }
  }
  if (!latestUser) return { state: "idle", reason: "no-native-turn" };
  const completed = events.slice(latestUser.index + 1).some((event) =>
    event?.type === "web"
    && event.subtype === "turn-done"
    && (!latestUser.operationKey || !event.operationKey || event.operationKey === latestUser.operationKey));
  return completed
    ? { state: "idle", reason: "native-turn-complete" }
    : { state: "active", reason: "native-turn-incomplete" };
}

/** WHAT: Parses stable tmux session identity rows. WHY: Keeps receipt generations bound to actual live sessions. */
export function parseTmuxSessionRows(text) {
  return String(text || "").split("\n").map((line) => line.trim()).filter(Boolean)
    .map((line) => {
      const [id, name, created] = line.split("\t");
      return { id, name, created, identity: `${id}:${name}:${created}` };
    }).filter((row) => row.id && row.name && row.created);
}

/** WHAT: Parses live pane paths for worktree discovery. WHY: Keeps restart checks tied to where agents actually execute. */
export function parseTmuxPaneRows(text) {
  return String(text || "").split("\n").map((line) => line.trim()).filter(Boolean)
    .map((line) => {
      const [agent, pane, path] = line.split("\t");
      return { agent, pane: Number(pane), path };
    }).filter((row) => row.agent && Number.isSafeInteger(row.pane) && row.path);
}

function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function readBootId() {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
  catch { return null; }
}

function readTurns(engine, paneDir) {
  const reader = engine === "codex"
    ? readLastTurnsCodex
    : engine === "kimi" ? readLastTurnsKimi : readLastTurns;
  return reader(paneDir, { limit: 1, tailBytes: TAIL_BYTES, headless: true })?.turns || [];
}

async function collectPanels(ctx, agents, liveNames) {
  const panels = [];
  for (const agent of agents) {
    if (agent.backend === "native") {
      for (let pane = 0; pane < agent.panes.length; pane++) {
        const engine = restartPaneEngine(agent.panes[pane]);
        if (!engine) continue;
        try {
          const snapshot = await ctx.agent.nativeRuntime.history(agent.name, pane);
          panels.push({
            agent: agent.name,
            pane,
            engine,
            ...nativePanelRestartState(snapshot.events),
          });
        } catch {
          panels.push({ agent: agent.name, pane, engine, state: "unknown", reason: "native-runtime-unavailable" });
        }
      }
      continue;
    }
    if (!liveNames.has(agent.name)) continue;
    for (let pane = 0; pane < agent.panes.length; pane++) {
      const engine = restartPaneEngine(agent.panes[pane]);
      if (!engine) continue;
      const paneDir = join(agent.dir, ".agents", String(pane));
      try {
        panels.push({ agent: agent.name, pane, engine, ...panelRestartState(readTurns(engine, paneDir)) });
      } catch {
        panels.push({ agent: agent.name, pane, engine, state: "unknown", reason: "journal-unreadable" });
      }
    }
  }
  return panels;
}

function collectDeliveries(queue) {
  return queue.targets().flatMap(({ agentName, pane }) => queue.list(agentName, pane))
    .filter((job) => !TERMINAL_DELIVERY_STATES.has(job.status)
      || needsDeliveryTerminalNotice(job)
      || job.cancelRequestStatus === "requested");
}

function git(cwd, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function resolveGitPath(worktree, path) {
  return isAbsolute(path) ? path : resolve(worktree, path);
}

function worktreeOperation(path) {
  for (const [name, gitPathName] of [
    ["rebase", "rebase-merge"],
    ["rebase", "rebase-apply"],
    ["merge", "MERGE_HEAD"],
    ["cherry-pick", "CHERRY_PICK_HEAD"],
    ["revert", "REVERT_HEAD"],
  ]) {
    const gitPath = git(path, ["rev-parse", "--git-path", gitPathName], { allowFailure: true });
    if (gitPath && existsSync(resolveGitPath(path, gitPath))) return name;
  }
  return null;
}

function discoverGitRoots(seeds, { maxDepth = 3, maxEntries = 2_000 } = {}) {
  const roots = new Set();
  let visited = 0;
  const walk = (path, depth) => {
    if (depth > maxDepth || visited >= maxEntries || !existsSync(path)) return;
    visited++;
    if (existsSync(join(path, ".git"))) {
      roots.add(path);
      return;
    }
    let entries;
    try { entries = readdirSync(path, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || ["node_modules", ".git", "build", "dist", ".cache"].includes(entry.name)) continue;
      walk(join(path, entry.name), depth + 1);
    }
  };
  for (const seed of seeds) walk(seed, 0);
  return roots;
}

function collectWorktrees(agents, paneRows) {
  const roots = new Set();
  const seeds = [...agents.map((agent) => agent.dir), ...paneRows.map((pane) => pane.path)];
  for (const candidate of discoverGitRoots(seeds)) {
    const root = git(candidate, ["rev-parse", "--show-toplevel"], { allowFailure: true });
    if (root) roots.add(root);
  }
  const paths = new Set();
  for (const root of roots) {
    const porcelain = git(root, ["worktree", "list", "--porcelain"], { allowFailure: true });
    if (porcelain === null) {
      paths.add(root);
      continue;
    }
    for (const line of porcelain.split("\n")) {
      if (line.startsWith("worktree ")) paths.add(line.slice("worktree ".length));
    }
  }
  return [...paths].sort().map((path) => {
    const status = git(path, ["status", "--porcelain=v1", "--untracked-files=normal"], { allowFailure: true });
    return {
      path,
      dirty: Boolean(status),
      operation: status === null ? "status-unavailable" : worktreeOperation(path),
    };
  });
}

function collectAuth() {
  const probe = (command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 5_000 });
    if (result.error?.code === "ENOENT") return "unavailable";
    if (result.error?.code === "ETIMEDOUT") return "timeout";
    return result.status === 0 ? "ok" : "not-ok";
  };
  return {
    codex: probe("codex", ["login", "status"]),
    claude: existsSync(join(homedir(), ".claude")) ? "configured-unverified" : "unavailable",
    kimi: existsSync(join(homedir(), ".kimi-code")) ? "configured-unverified" : "unavailable",
  };
}

function receiptDir(home = homedir()) {
  return join(home, ".agentmux", "restart-ready");
}

function receiptPath(id, home = homedir()) {
  if (!RECEIPT_ID.test(String(id || ""))) throw new Error("invalid restart-ready receipt id");
  return join(receiptDir(home), `${id}.json`);
}

function writeReceipt(receipt, home = homedir()) {
  const directory = receiptDir(home);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = receiptPath(receipt.receiptId, home);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return path;
}

async function observeReadiness(ctx) {
  const agents = listAgents(ctx.configPath);
  let sessionRows = [];
  let paneRows = [];
  try {
    const result = await ctx.tmux("list-sessions -F '#{session_id}\t#{session_name}\t#{session_created}'");
    sessionRows = parseTmuxSessionRows(result.stdout);
  } catch {}
  try {
    const result = await ctx.tmux("list-panes -a -F '#{session_name}\t#{pane_index}\t#{pane_current_path}'");
    paneRows = parseTmuxPaneRows(result.stdout);
  } catch {}
  const liveNames = new Set(sessionRows.map((row) => row.name));
  const manifest = JSON.parse(readFileSync(join(ctx.bridgeDir, ".agentmux-release.json"), "utf8"));
  const identity = observeReleaseIdentity({
    runtimeRoot: ctx.bridgeDir,
    entryPath: join(ctx.bridgeDir, "bin", "agent-cli.mjs"),
    home: homedir(),
    readRemoteMaster: () => manifest.sourceSha,
  });
  const decision = identityDecision(identity);
  return buildRestartReadiness({
    bootId: readBootId(),
    sourceSha: identity.sourceSha,
    configSha: sha256(readFileSync(ctx.configPath, "utf8")),
    sessions: sessionRows.map((row) => row.identity),
    panels: await collectPanels(ctx, agents, liveNames),
    deliveries: collectDeliveries(ctx.deliveryQueue),
    worktrees: collectWorktrees(agents, paneRows),
    auth: collectAuth(),
    identityOk: decision.allowRevive,
    identityReason: decision.reason,
  });
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.ready) {
    console.log(`BLOCKED restart-ready (${result.blockers.length})`);
    for (const blocker of result.blockers) {
      console.log(`  ${blocker.kind} ${blocker.id}: ${blocker.reason}`);
    }
    return;
  }
  console.log(`RESTART_READY id=${result.receipt.receiptId} expires=${new Date(result.receipt.expiresAtMs).toISOString()}`);
}

/** WHAT: Routes the restart readiness inventory or one prior receipt check. WHY: Keeps destructive authority outside the Windows transport. */
export async function cmdRestartReady(args, ctx) {
  const json = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");
  if (positional.length === 0) {
    const result = await observeReadiness(ctx);
    if (result.ready) writeReceipt(result.receipt);
    printResult(result, json);
    if (!result.ready) process.exitCode = 1;
    return;
  }
  if (positional.length !== 2 || positional[0] !== "verify") {
    throw new Error("Usage: amux restart-ready [--json] | amux restart-ready verify RECEIPT_ID [--json]");
  }
  const id = positional[1];
  let receipt;
  try { receipt = JSON.parse(readFileSync(receiptPath(id), "utf8")); }
  catch { throw new Error(`restart-ready receipt ${id} is missing or unreadable`); }
  const current = await observeReadiness(ctx);
  if (!current.ready) {
    printResult(current, json);
    process.exitCode = 1;
    return;
  }
  const verdict = verifyRestartReadyReceipt(receipt, {
    receiptId: id,
    bootId: current.receipt.bootId,
    fleetGeneration: current.receipt.fleetGeneration,
    sourceSha: current.receipt.sourceSha,
  });
  const result = verdict.allow
    ? { ready: true, receipt, verdict }
    : { ready: false, blockers: [{ kind: "receipt", id, reason: verdict.reason }], verdict };
  printResult(result, json);
  if (!verdict.allow) process.exitCode = 1;
}
