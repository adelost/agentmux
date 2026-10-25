import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { operatorName } from "./runtime-defaults.mjs";

/** WHAT: Returns the hash of exact command output bytes. WHY: Prevents a summary from standing in for observed output. */
export const onTrackHash = value => createHash("sha256").update(value).digest("hex");
/** WHAT: Reads a bounded immutable Git object without a shell. WHY: Prevents reviewer input from executing commands or selecting another repository. */
export const onTrackGit = (root, args) => execFileSync("git", ["-C", root, ...args], {
  encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
});
/** WHAT: Checks the protocol's observation window. WHY: Prevents recent reports from making old or future observations fresh. */
export const onTrackFresh = (at, now) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= now && now - Date.parse(at) <= 3600000;

/** WHAT: Resolves a project-relative evidence file. WHY: Keeps quotes from escaping the configured repository. */
export function onTrackFile(project, path) {
  if (typeof path !== "string" || !path || path.includes(":") || path.split(/[\\/]/u).some(p => p === ".." || p === ".git")) throw Error("invalid evidence path");
  const file = resolve(project.root, path);
  if (!file.startsWith(resolve(project.root) + sep) || !existsSync(file)) throw Error("evidence file missing or outside project");
  return file;
}

/** WHAT: Checks a quoted Git line or controller-captured command. WHY: Prevents reviewer-provided hashes from standing in for execution. */
export function verifyOnTrackEvidence(evidence, { project, cycle, at, commands = {} }) {
  try {
    const immutableBaselineRead = evidence?.kind === "file" && cycle.baseline && Date.parse(evidence.at) >= cycle.at && Date.parse(evidence.at) <= at && at - Date.parse(evidence.at) <= 7200000;
    if (!onTrackFresh(evidence?.at, at) && !immutableBaselineRead) return false;
    if (evidence.kind === "file") {
      onTrackFile(project, evidence.path);
      if (!/^[a-f0-9]{40}$/u.test(evidence.sha) || !Number.isSafeInteger(evidence.line) || evidence.line < 1 || !evidence.quote) return false;
      if (evidence.path === project.ledger && evidence.sha !== cycle.tip
        && !cycle.outcomeHistory?.commits?.includes(evidence.sha) && evidence.sha !== cycle.outcomeHistory?.base) return false;
      const text = onTrackGit(project.root, ["show", `${evidence.sha}:${evidence.path}`]);
      return text.split("\n")[evidence.line - 1] === evidence.quote;
    }
    if (evidence.kind === "command") {
      const record = commands[evidence.record];
      return !!record && record.project === project.id && record.cycle === cycle.id
        && Number.isSafeInteger(record.exitCode)
        && record.at === evidence.at && onTrackFresh(record.at, at)
        && record.exitCode === evidence.exitCode && record.sha256 === evidence.sha256
        && onTrackHash(record.stdout) === record.sha256 && JSON.stringify(record.command) === JSON.stringify(evidence.command);
    }
    return false;
  } catch { return false; }
}

/** WHAT: Reads a live observation from its captured source. WHY: Prevents a new reviewer timestamp from refreshing old live proof. */
export function verifyOnTrackLive(proof, context) {
  if (!verifyOnTrackEvidence(proof?.evidence, context)) return false;
  try {
    const evidence = proof.evidence;
    const text = evidence.kind === "command" ? context.commands[evidence.record].stdout
      : onTrackGit(context.project.root, ["show", `${evidence.sha}:${evidence.path}`]);
    const source = JSON.parse(text);
    const observed = source.live?.find(item => item.path === proof.path);
    return observed?.result === "PASS" && observed.at === proof.at && onTrackFresh(observed.at, context.at)
      && (evidence.kind !== "command" || evidence.exitCode === 0);
  } catch { return false; }
}

/** WHAT: Builds actual output evidence from an explicitly configured project probe. WHY: Separates explicit command execution from receipt submission. */
export function captureOnTrackCommand({ project, cycle, probe, now = Date.now() }) {
  const command = project.probes?.[probe];
  if (!Array.isArray(command) || !command.length || !command.every(arg => typeof arg === "string" && arg)) throw Error("unknown configured probe");
  const result = spawnSync(command[0], command.slice(1), { cwd: project.root, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" } });
  const stdout = result.stdout || "";
  return { project: project.id, cycle: cycle.id, probe, command, at: new Date(now).toISOString(),
    exitCode: result.status, stdout, stderr: result.stderr || "", error: result.error?.message || null, sha256: onTrackHash(stdout) };
}

const normalized = value => value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9#]/gu, "");
/** WHAT: Returns one explicit owner identity from a TASKS owner cell. WHY: Keeps role annotations separate from pane addresses and preserves ambiguous ownership. */
export function onTrackOwner(value) {
  const addresses = [...new Set(String(value).match(/[\w-]+:\d+/gu) || [])];
  if (addresses.length === 1) return addresses[0];
  if (!addresses.length && ["human", operatorName()].includes(String(value).trim())) return "human";
  return null;
}
/** WHAT: Reads TASKS fields by their existing column names. WHY: Projects keep their canonical Markdown instead of maintaining another task list. */
export function onTrackRows(text) {
  let headers = [];
  const rows = {};
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.startsWith("|")) continue;
    const cells = line.split(/(?<!\\)\|/u).slice(1, -1).map(s => s.trim());
    if (["#", "id", "row"].includes(normalized(cells[0] || ""))) { headers = cells.map(normalized); continue; }
    if (!/^\d+[a-z]*$/u.test(cells[0] || "") || !headers.length) continue;
    if (rows[cells[0]]) throw Error(`duplicate TASKS row ${cells[0]}; source is ambiguous`);
    const field = (...names) => { const pos = names.map(name => headers.indexOf(name)).find(index => index >= 0); return pos === undefined ? "" : cells[pos] || ""; };
    rows[cells[0]] = { row: cells[0], line: index + 1, quote: line, owner: field("owner", "agare"), ownerId: onTrackOwner(field("owner", "agare")), estimate: field("estimate", "budget"),
      outcome: field("donewhen", "acceptance", "klartnar", "outcome", "vad"), state: field("state", "status", "lage"), title: field("outcome", "task", "title", "vad"), source: field("source") };
  }
  return rows;
}
