import { homedir } from "node:os";
import { join, isAbsolute, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { readWindow } from "./ask-ledger.mjs";
import { automatedCopies, isHumanAsk, inferAskOrigin } from "./ask-origin.mjs";
import { observedAskOrigin } from "./ask-source-evidence.mjs";
import { readAskBindings } from "./ask-bindings.mjs";
import { onTrackGit, onTrackRows } from "./on-track-evidence.mjs";
import { createState } from "./state.mjs";

/** WHAT: Resolves the shared review configuration and state paths. WHY: Keeps CLI submissions and bridge scheduling on the same durable records. */
export function onTrackPaths(home = homedir()) {
  const root = process.env.AMUX_ON_TRACK_DIR || join(home, ".agentmux", "on-track");
  return { config: join(root, "projects.json"), state: join(root, "state.json") };
}

/** WHAT: Checks explicit project routing and live-path declarations. WHY: Keeps project routing separate from the canonical task database. */
export function validateOnTrackProjects(projects) {
  if (!Array.isArray(projects)) throw Error("on-track projects must be an array");
  const ids = new Set();
  for (const p of projects) {
    if (!/^[a-z0-9_-]+$/u.test(p.id) || ids.has(p.id) || !isAbsolute(p.root || "")
      || (p.enabled !== undefined && typeof p.enabled !== "boolean")
      || !/^[\w./-]+\.md$/u.test(p.ledger || "") || p.ledger.startsWith("/") || p.ledger.split("/").includes("..")
      || !/^[\w-]+:\d+$/u.test(p.reviewer || "") || !/^[\w-]+:\d+$/u.test(p.dispatcher || "")
      || !Array.isArray(p.askAgents) || !p.askAgents.length || !p.askAgents.every(a => /^[\w-]+$/u.test(a))
      || !Array.isArray(p.livePaths) || !p.livePaths.length || !p.livePaths.every(s => typeof s === "string" && s.trim())) throw Error(`invalid on-track project ${p.id || "unknown"}`);
    ids.add(p.id);
    onTrackGit(p.root, ["rev-parse", "--verify", "--end-of-options", `${p.ref || "HEAD"}^{commit}`]);
  }
  return projects;
}

/** WHAT: Reads configured review projects, leaving an absent opt-in file empty. WHY: Prevents registration from waking an entire fleet. */
export function readOnTrackProjects(path = onTrackPaths().config) {
  try { return validateOnTrackProjects(JSON.parse(readFileSync(path, "utf8"))); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

/** WHAT: Builds a frozen project ask and TASKS snapshot for one review. WHY: Prevents asks from disappearing between reminder and submission. */
export function snapshotOnTrackProject(project, at, { window = readWindow, bindings = readAskBindings } = {}) {
  const bound = bindings();
  const result = window({ since: at - 86400000, until: at, provenance: true });
  if (!result.files.length) throw Error("ask-ledger coverage unavailable");
  const rootPrefix = `${project.root}/`;
  const common = root => onTrackGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  const ownCommon = common(project.root), roots = new Map();
  const commonOfBinding = binding => {
    const match = /^(.*\.md):([^:]+)$/u.exec(binding.ref);
    if (!match) return null;
    const dir = dirname(match[1]);
    if (!roots.has(dir)) {
      try { roots.set(dir, common(dir)); } catch { roots.set(dir, null); }
    }
    return roots.get(dir);
  };
  const inScope = ask => project.askAgents.includes(ask.agent) || bound.some(b =>
    [ask.id, ...(ask.observationIds || [])].includes(b.ledgerId) && (b.ref.startsWith(rootPrefix) || commonOfBinding(b) === ownCommon));
  const copies = automatedCopies(result.asks);
  const humans = result.asks.filter(ask => isHumanAsk(ask) && !copies.has(ask));
  const additional = result.asks.filter(ask => ["cli", "unknown", "voice-pwa", "voice", "link", "engine-backfill"].includes(ask.source)
    && observedAskOrigin(ask, inferAskOrigin) === "human"
    && isHumanAsk({ ...ask, source: "pane-hook" }));
  const unknowns = result.asks.filter(ask => observedAskOrigin(ask, inferAskOrigin) === "unknown");
  const asks = [...new Map([...humans, ...additional, ...unknowns].map(ask => [ask.id, ask])).values()].filter(inScope)
    .map(ask => ({ id: ask.id, observationIds: ask.observationIds || [ask.id], nativeEvent: ask.nativeEvent,
      originUncertain: observedAskOrigin(ask, inferAskOrigin) === "unknown",
      ts: ask.ts, agent: ask.agent, pane: ask.pane, text: ask.verbatim, source: ask.ledgerPath }));
  const excludedAutomation = result.asks.filter(ask => inScope(ask) && ask.originEvidence && observedAskOrigin(ask, inferAskOrigin) === "system")
    .map(ask => ({ id: ask.id, observationIds: ask.observationIds || [ask.id], evidence: ask.originEvidence }));
  for (const ask of asks) {
    const binding = bound.findLast(b => ask.observationIds.includes(b.ledgerId));
    if (binding?.kind === "close") { ask.disposition = { kind: "not-order", binding }; continue; }
    if (binding?.kind !== "row") continue;
    const match = /^(.*\.md):([^:]+)$/u.exec(binding.ref);
    if (!match) continue;
    try {
      const dir = dirname(match[1]);
      if (!roots.has(dir)) roots.set(dir, common(dir));
      if (roots.get(dir) !== ownCommon) ask.disposition = { kind: "other-project", binding, common: roots.get(dir) };
    } catch { /* Missing historical target stays in scope, never silently excluded. */ }
  }
  const tip = onTrackGit(project.root, ["rev-parse", "--verify", "--end-of-options", `${project.ref || "HEAD"}^{commit}`]).trim();
  const since = new Date(at - 86400000).toISOString();
  const base = onTrackGit(project.root, ["rev-list", "-1", `--before=${since}`, tip, "--", project.ledger]).trim();
  const commits = onTrackGit(project.root, ["log", "--reverse", "--format=%H %ct", `--since=${since}`, tip, "--", project.ledger]).trim().split("\n").filter(Boolean);
  if (commits.length > 300) throw Error("TASKS history exceeds bounded 300-commit read; review scope UNKNOWN");
  const historyErrors = [];
  const historicalRows = sha => {
    try { return onTrackRows(onTrackGit(project.root, ["show", `${sha}:${project.ledger}`])); }
    catch (error) { historyErrors.push({ sha, error: error.message }); return null; }
  };
  let previous = base ? historicalRows(base) : {};
  const rowFirstSeen = {};
  const changes = [];
  for (const commit of commits) {
    const [sha, seconds] = commit.split(" ");
    const next = historicalRows(sha);
    if (!next) { previous = null; continue; }
    for (const row of Object.keys(next)) if (previous && !previous[row] && rowFirstSeen[row] === undefined) rowFirstSeen[row] = Number(seconds) * 1000;
    for (const [row, value] of Object.entries(previous || {})) {
      if (next[row]?.outcome !== value.outcome) changes.push({ row, sha, at: Number(seconds) * 1000,
        before: value.outcome, after: next[row]?.outcome || null });
    }
    previous = next;
  }
  return { tip, asks, excludedAutomation, rowFirstSeen, bindings: bound.filter(b => asks.some(a => a.observationIds.includes(b.ledgerId))),
    outcomeHistory: { base: base || null, changes, errors: historyErrors, commits: commits.map(line => line.split(" ")[0]) },
    askScope: { agents: project.askAgents, rule: "all human asks to these routing agents, plus asks already bound to this repository; includes ambiguous messages for reviewer disposition" } };
}

/** WHAT: Builds the atomic state store for on-track records. WHY: Prevents concurrent CLI and bridge writes from dropping deadlines. */
export const onTrackStore = () => createState(onTrackPaths().state);
