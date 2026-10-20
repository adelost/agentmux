/**
 * WHAT: Runs the rule-file checks over repositories against their trunk and reports findings per repo.
 * WHY: Keeps repo rule files trustworthy without ever writing to a repo, a ref or a checkout.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { findingFingerprint, loadBaseline } from "./contract-lint.mjs";
import { loadLintPolicy } from "./lint-ratchet.mjs";
import { exists, makeTreeFacts, references } from "./rules-lint-refs.mjs";
import {
  claudeShape, differingLines, heuristicFindings, layerDuplicates, protectedLines, removedProtected,
} from "./rules-lint-text.mjs";

const SETTING_KEY = "cc-plugin-agents-md@builtin";
const SETTING_VALUE = "claude-md-and-agents-md";
const RULE_FILES = ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"];
const FAR_BEHIND = 50;
const GIT_READ_ONLY = new Set(["rev-parse", "symbolic-ref", "for-each-ref", "ls-tree", "show", "cat-file", "rev-list", "log", "grep", "check-ignore"]);
const GIT_UNSAFE_FLAG = /^(?:--output(?:=|$)|-O$|--open-files-in-pager|--ext-diff$|--textconv$)/;
const GIT_REPO_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_PREFIX"];
const ICONS = { error: "✗", warn: "⚠", info: "ℹ" };

/**
 * WHAT: Defines the severity of every check; only the certain classes are errors.
 * WHY: Keeps one table so a heuristic cannot become an error by accident.
 */
export const SEVERITY = Object.freeze({
  exists: "error", link: "error", shape: "error", codex: "error", reach: "error", checkout: "error", removed: "error",
  // A missing path was right 1 time in 26 over 18 repos (20 Oct): outputs, planned files, other repos, examples.
  path: "warn", branch: "warn", loaded: "warn", trunk: "warn", count: "warn", status: "warn", size: "warn", "layer-dup": "warn",
  protected: "info",
});

function gitEnv() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  for (const name of GIT_REPO_ENV) delete env[name];
  return env;
}

/**
 * WHAT: Reads one repository through an allowlisted read-only git command, returning status and output.
 * WHY: Keeps every git call behind one allowlist, so the lint cannot write a ref, file or config.
 */
export function gitRead(repo, args) {
  const [command, ...rest] = args;
  const readOnly = GIT_READ_ONLY.has(command) || (command === "config" && rest[0] === "--get");
  const positional = rest.filter((arg) => !arg.startsWith("-"));
  if (!readOnly || (command === "symbolic-ref" && positional.length > 1) || rest.some((arg) => GIT_UNSAFE_FLAG.test(arg))) {
    throw new Error(`rules lint: git ${args.join(" ")} is not a read-only command`);
  }
  try {
    const out = execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8", maxBuffer: 1 << 28, env: gitEnv(), stdio: ["ignore", "pipe", "ignore"], timeout: 60_000,
    });
    return { ok: true, out, code: 0 };
  } catch (error) {
    return { ok: false, out: "", code: typeof error.status === "number" ? error.status : 128 };
  }
}

const shortDisplay = (path, home) => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);

function repoTop(target) {
  let dir = resolve(target);
  try { if (statSync(dir).isFile()) dir = dirname(dir); } catch { return null; }
  const top = gitRead(dir, ["rev-parse", "--show-toplevel"]);
  if (top.ok) return resolve(top.out.trim());
  // A work tree whose config says core.bare=true still has a .git entry: read it as the repo it is.
  for (let walk = dir; ; walk = dirname(walk)) {
    if (existsSync(join(walk, ".git")) && gitRead(walk, ["rev-parse", "--git-dir"]).ok) return walk;
    if (dirname(walk) === walk) return null;
  }
}

function policyAt(top) {
  try {
    const policy = loadLintPolicy(top, []);
    return policy.configPath && dirname(policy.configPath) === top ? policy : null;
  } catch { return null; }
}

function trunkOf(git, policy) {
  const remote = git(["config", "--get", "remote.origin.url"]).ok;
  const resolves = (ref) => git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok;
  const note = [];
  if (policy?.rulesTrunk) {
    if (resolves(policy.rulesTrunk)) return { ref: policy.rulesTrunk, source: "rules.trunk", remote, note };
    note.push(policy.rulesTrunk);
  }
  const head = git(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]).out.trim().replace(/^refs\/remotes\//, "");
  const candidates = [[head, "origin/HEAD"], ["origin/main", "fallback"], ["origin/master", "fallback"], ["main", "fallback"], ["master", "fallback"]];
  for (const [ref, source] of candidates) if (ref && resolves(ref)) return { ref, source, remote, note };
  const branch = git(["symbolic-ref", "-q", "--short", "HEAD"]).out.trim();
  return { ref: branch || "HEAD", source: "none", remote, note };
}

function fetchedAt(git, top) {
  const common = git(["rev-parse", "--git-common-dir"]);
  if (!common.ok) return null;
  try { return statSync(join(resolve(top, common.out.trim()), "FETCH_HEAD")).mtime; } catch { return null; }
}

const two = (n) => String(n).padStart(2, "0");
const stamp = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;

function checkoutOf(git, trunk) {
  const sha = git(["rev-parse", "HEAD"]).out.trim();
  const branch = git(["symbolic-ref", "-q", "--short", "HEAD"]).out.trim() || null;
  const counts = git(["rev-list", "--left-right", "--count", `HEAD...${trunk.ref}`]).out.trim().split(/\s+/).map(Number);
  const [ahead = 0, behind = 0] = counts;
  const onTrunk = Boolean(branch) && (branch === trunk.ref || `origin/${branch}` === trunk.ref);
  return { sha, branch, ahead, behind, onTrunk };
}

function stateText(state) {
  const place = state.branch ? `on ${state.branch}` : `detached at ${state.sha.slice(0, 7)}`;
  return `${place}, ${state.ahead && state.branch ? `${state.ahead} ahead, ` : ""}${state.behind} behind`;
}

function headerOf(top, trunk, state, fetched, home) {
  const where = shortDisplay(top, home);
  const named = trunk.source === "rules.trunk" ? `${trunk.ref} (rules.trunk)` : trunk.ref;
  const base = trunk.source === "none" ? `no trunk ref, using ${trunk.ref}` : `trunk ${named}`;
  const remote = trunk.remote ? `, fetched ${fetched ? stamp(fetched) : "never"}` : ", no remote";
  return `${where} · ${base}${remote} · ${stateText(state)}`;
}

function checkoutFindings(state, trunk) {
  const { branch, ahead, behind, sha } = state;
  if (!branch && behind > 0) return [{ tag: "checkout", msg: `checkout detached at ${sha.slice(0, 7)}, ${behind} behind ${trunk.ref}` }];
  if (behind > FAR_BEHIND) return [{ tag: "checkout", msg: `checkout is ${behind} commits behind ${trunk.ref}` }];
  if (!branch && ahead > 0) return [{ tag: "branch", msg: `checkout detached at ${sha.slice(0, 7)}, ${ahead} ahead of ${trunk.ref}` }];
  if (branch && (!state.onTrunk || behind > 0)) {
    return [{ tag: "branch", msg: `checkout is on ${branch}, ${ahead} ahead, ${behind} behind ${trunk.ref}` }];
  }
  return [];
}

function readTree(git, ref) {
  const listing = git(["ls-tree", "-r", "-z", ref]);
  const entries = new Map();
  for (const row of listing.out.split("\0")) {
    const m = row.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s);
    if (m) entries.set(m[4], { mode: m[1], type: m[2] });
  }
  const all = [...entries];
  return {
    entries,
    paths: all.filter(([, e]) => e.type === "blob").map(([path]) => path),
    gitlinks: all.filter(([, e]) => e.type === "commit").map(([path]) => path),
  };
}

function branchNames(git) {
  const refs = git(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"]).out.split("\n");
  return refs.flatMap((ref) => {
    const name = ref.replace(/^refs\/(?:heads|remotes\/origin)\//, "");
    return ref && name !== ref && name !== "HEAD" ? [name] : [];
  });
}

/** Reads one rule file at trunk, following a trunk symlink one hop, so symlinked and plain files compare alike. */
function trunkRuleFile(git, ref, tree, file) {
  const entry = tree.entries.get(file);
  if (!entry || entry.type !== "blob") return null;
  const raw = git(["show", `${ref}:${file}`]).out;
  if (entry.mode !== "120000") return { file, text: raw, symlink: false };
  const target = raw.trim();
  const resolved = posix.normalize(posix.join(posix.dirname(file), target));
  const linked = tree.entries.get(resolved)?.type === "blob" ? git(["show", `${ref}:${resolved}`]).out : raw;
  return { file, text: linked, symlink: true, target };
}

function loadedMessage(trunk, file, atTrunk, working) {
  if (!atTrunk) return `panes load ${file}, which ${trunk.ref} does not have`;
  if (working === null) return `panes load no ${file}, but ${trunk.ref} has one`;
  return `panes load a different file than ${trunk.ref}, lines differ: ${differingLines(atTrunk.text, working)}`;
}

function loadedFindings(top, trunk, rules) {
  const names = new Set([...rules.map((r) => r.file), ...RULE_FILES.filter((file) => existsSync(join(top, file)))]);
  const findings = [];
  for (const file of [...names].sort()) {
    const atTrunk = rules.find((r) => r.file === file) || null;
    let working = null;
    try { working = readFileSync(join(top, file), "utf8"); } catch { /* missing or a dangling link */ }
    const same = atTrunk && working !== null && atTrunk.text.replace(/\r\n/g, "\n") === working.replace(/\r\n/g, "\n");
    if (!same && (atTrunk || working !== null)) findings.push({ tag: "loaded", file, msg: loadedMessage(trunk, file, atTrunk, working) });
  }
  return findings;
}

function fileFindings(rule, shared) {
  const { git, trunk, facts, home, layers } = shared;
  const out = [];
  const ignored = (path) => git(["check-ignore", "--quiet", "--no-index", "--", path]).ok;
  const ctx = { trunk: trunk.ref, ruleFile: rule.file, home, pathExists: existsSync, ignored };
  for (const ref of references(rule.text)) {
    const msg = exists(ref, facts, ctx);
    if (msg) out.push({ tag: ref.kind === "link" || ref.kind === "path" ? ref.kind : "exists", file: rule.file, line: ref.line, msg });
  }
  for (const h of heuristicFindings(rule.text)) out.push({ ...h, file: rule.file });
  for (const d of layerDuplicates(rule.text, layers)) {
    out.push({ tag: "layer-dup", file: rule.file, line: d.line, msg: `repeats ${d.layer.name}, ${d.layer.label}:${d.layerLine} (${d.share.toFixed(2)})` });
  }
  const mine = protectedLines(rule.text);
  if (mine.length) out.push({ tag: "protected", file: rule.file, msg: `${mine.length} protected line${mine.length === 1 ? "" : "s"}, his dated words` });
  for (const gone of removedProtected(git, trunk.ref, rule.file)) {
    const many = gone.lines.length > 1;
    out.push({ tag: "removed", file: rule.file, msg: `${gone.lines.length} protected line${many ? "s" : ""} (was line${many ? "s" : ""} ${gone.lines.join(", ")}) removed in ${gone.short} on ${gone.date} and not found anywhere in ${trunk.ref}` });
  }
  return out;
}

function withSeverity(top, raw) {
  const sev = SEVERITY[raw.tag];
  if (!sev) throw new Error(`rules lint: no severity for check ${raw.tag}`);
  return { line: null, file: null, ...raw, sev, code: `rules.${raw.tag}`, path: raw.path || (raw.file ? join(top, raw.file) : top) };
}

function lintRepo(top, shared) {
  const git = (args) => gitRead(top, args);
  const policy = policyAt(top);
  const trunk = trunkOf(git, policy);
  if (!git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).ok) return { root: top, header: null, skipped: "no commits yet", findings: [] };
  const state = checkoutOf(git, trunk);
  const tree = readTree(git, trunk.ref);
  const facts = makeTreeFacts({ paths: tree.paths, gitlinks: tree.gitlinks, branches: branchNames(git), read: (path) => git(["show", `${trunk.ref}:${path}`]).out });
  const rules = RULE_FILES.map((file) => trunkRuleFile(git, trunk.ref, tree, file)).filter(Boolean);
  const raw = [...checkoutFindings(state, trunk), ...loadedFindings(top, trunk, rules)];
  if (trunk.note.length) raw.push({ tag: "trunk", msg: `rules.trunk ${trunk.note[0]} was not found, compared with ${trunk.ref}` });
  for (const rule of rules) raw.push(...fileFindings(rule, { ...shared, git, trunk, facts }));
  const agents = rules.find((r) => r.file === "AGENTS.md") || null;
  raw.push(...claudeShape({ agents, claudes: rules.filter((r) => r.file !== "AGENTS.md"), setting: shared.setting }));
  const fetched = fetchedAt(git, top);
  return {
    root: top, skipped: null, header: headerOf(top, trunk, state, fetched, shared.home), trunk: { ...trunk, fetched },
    checkout: state, files: rules.map((r) => r.file), findings: raw.map((f) => withSeverity(top, f)),
  };
}

function settingsFiles(home, profilesDir) {
  const files = [join(home, ".claude", "settings.json")];
  try {
    for (const entry of readdirSync(join(profilesDir, "claude"))) {
      const dir = join(profilesDir, "claude", entry);
      if (statSync(dir).isDirectory()) files.push(join(dir, "settings.json"));
    }
  } catch { /* no profiles directory */ }
  const unique = new Map();
  for (const file of files) {
    let real = file;
    try { real = realpathSync(file); } catch { /* a missing file is its own identity */ }
    if (!unique.has(real)) unique.set(real, file);
  }
  return [...unique.values()];
}

function hasSetting(file) {
  try { return JSON.parse(readFileSync(file, "utf8"))?.pluginConfigs?.[SETTING_KEY]?.options?.instructionFiles === SETTING_VALUE; } catch { return false; }
}

function machineCheck(home, profilesDir) {
  const missing = settingsFiles(home, profilesDir).filter((file) => !hasSetting(file));
  return {
    setting: missing.length === 0,
    findings: missing.map((path) => withSeverity(home, {
      tag: "reach", path, msg: `${shortDisplay(path, home)} lacks cc-plugin-agents-md instructionFiles=${SETTING_VALUE}`,
    })),
  };
}

function loadLayers(home) {
  const specs = [
    { name: "the global layer", label: "~/.claude/CLAUDE.md", path: join(home, ".claude", "CLAUDE.md") },
    { name: "the global layer", label: "~/.codex/AGENTS.md", path: join(home, ".codex", "AGENTS.md") },
    { name: "the shared layer", label: ".agents/CLAUDE.md", path: join(home, "lsrc", ".agents", "CLAUDE.md") },
  ];
  const seen = new Set();
  const layers = [];
  for (const spec of specs) {
    try {
      const real = realpathSync(spec.path);
      if (!seen.has(real)) { seen.add(real); layers.push({ name: spec.name, label: spec.label, text: readFileSync(real, "utf8") }); }
    } catch { /* a layer that is not installed here */ }
  }
  return layers;
}

/**
 * WHAT: Lints the rule files of every repository the targets lead to and returns findings per repo.
 * WHY: Keeps one run, one trunk lookup and one settings read for all repos, with nothing written anywhere.
 */
export function lintRules(targets, options = {}) {
  const started = performance.now();
  const home = options.home || process.env.HOME || homedir();
  const profilesDir = options.profilesDir || process.env.AMUX_ACCOUNT_PROFILES_DIR || join(home, ".config", "agent", "account-profiles");
  const machine = machineCheck(home, profilesDir);
  const shared = { home, layers: loadLayers(home), setting: machine.setting };
  const seen = new Set();
  const repos = [];
  for (const target of targets) {
    const top = repoTop(target);
    if (!top) { repos.push({ root: resolve(target), header: null, skipped: "not a git repository", findings: [] }); continue; }
    if (seen.has(top)) continue;
    seen.add(top);
    repos.push(lintRepo(top, shared));
  }
  return { home, machine: machine.findings, repos, baselined: 0, ms: performance.now() - started };
}

/**
 * WHAT: Filters out findings a baseline file already accepts and counts them.
 * WHY: Keeps a reviewed false error from failing every later run, as the contract lint baseline does.
 */
export function applyBaseline(run, baselinePath) {
  const baseline = loadBaseline(baselinePath);
  let baselined = 0;
  const keep = (root) => (f) => {
    const accepted = f.sev !== "info" && baseline.has(findingFingerprint(f, root));
    if (accepted) baselined += 1;
    return !accepted;
  };
  const machine = run.machine.filter(keep(run.home));
  const repos = run.repos.map((repo) => ({ ...repo, findings: repo.findings.filter(keep(repo.root)) }));
  return { ...run, machine, repos, baselined };
}

/**
 * WHAT: Saves the rules findings into a baseline file and keeps the entries other checks wrote there.
 * WHY: Prevents a rules run from wiping the contract lint's accepted findings from the shared baseline file.
 */
export function writeRulesBaseline(path, run) {
  const foreign = [...loadBaseline(path)].filter((key) => !/^[^:]*:rules\.[\w-]+:/.test(key));
  const mine = [
    ...run.machine.map((f) => findingFingerprint(f, run.home)),
    ...run.repos.flatMap((repo) => repo.findings.filter((f) => f.sev !== "info").map((f) => findingFingerprint(f, repo.root))),
  ];
  const findings = [...new Set([...foreign, ...mine])].sort();
  writeFileSync(path, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), findings }, null, 2)}\n`);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ORDER = { error: 0, warn: 1, info: 2 };

function findingLine(f) {
  const where = f.file ? (f.line ? `${f.file}:${f.line} ` : `${f.file}: `) : "";
  return `${ICONS[f.sev]} ${where}${f.msg} [${f.tag}]`;
}

/**
 * WHAT: Formats a rules run as the machine lines, one block per repo and a summary line.
 * WHY: Keeps errors first and never truncated, so a long warning list cannot hide a certain error.
 */
export function formatRulesReport(run, options = {}) {
  const home = options.home ?? run.home ?? process.env.HOME ?? "";
  const limit = options.limit || 80;
  const lines = [];
  for (const f of run.machine) lines.push(findingLine(f));
  if (run.machine.length) lines.push("");
  for (const repo of run.repos) {
    if (repo.skipped) { lines.push(`${shortDisplay(repo.root, home)} · ${repo.skipped}, skipped`); continue; }
    lines.push(repo.header);
    const sorted = [...repo.findings].sort((a, b) => ORDER[a.sev] - ORDER[b.sev] || (a.file || "").localeCompare(b.file || "") || (a.line || 0) - (b.line || 0));
    const errors = sorted.filter((f) => f.sev === "error");
    const rest = sorted.filter((f) => f.sev !== "error");
    for (const f of [...errors, ...rest.slice(0, limit)]) lines.push(`  ${findingLine(f)}`);
    if (rest.length > limit) lines.push(`  ... ${rest.length - limit} more`);
    lines.push("");
  }
  const linted = run.repos.filter((r) => !r.skipped);
  const all = [...run.machine, ...linted.flatMap((r) => r.findings)];
  const count = (sev) => all.filter((f) => f.sev === sev).length;
  const skipped = run.repos.length - linted.length;
  lines.push([
    plural(linted.length, "repo"), plural(count("error"), "error"), plural(count("warn"), "warning"),
    ...(run.baselined ? [`${run.baselined} baselined`] : []), ...(skipped ? [`${skipped} skipped`] : []),
    `${(run.ms / 1000).toFixed(1)} s`,
  ].join(" · "));
  return lines.join("\n");
}

/**
 * WHAT: Checks whether a run still holds an error after the baseline was applied.
 * WHY: Lets the command decide its exit code from certain findings only.
 */
export const hasErrors = (run) => [...run.machine, ...run.repos.flatMap((r) => r.findings)].some((f) => f.sev === "error");
