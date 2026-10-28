// WHAT: Counts how the bridge reaches tmux: questions over the control client, process starts and shadow checks.
// WHY: Keeps the cost of watching panes visible in `amux pulse io` instead of only in a CPU profile.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

const MAX_TARGETS = 200;
const MAX_DISAGREEMENTS = 20;
const emptyPaths = () => ({ control: 0, process: 0, degraded: 0, shadow: 0, connect: 0 });

/** WHAT: Builds an in-memory counter set for one bridge process. WHY: Separates counting from where counts are shown. */
export function createIoCounters({ now = () => Date.now() } = {}) {
  const since = now();
  const totals = emptyPaths();
  const byVerb = {};
  const byTarget = {};
  const disagreements = [];
  const replies = { count: 0, over1s: 0, maxMs: 0, late: 0 };
  const disagreementKinds = {};
  let disagreementCount = 0;
  let transport = { mode: null, state: null, reason: null };

  return {
    record({ path, verb, target }) {
      totals[path] = (totals[path] ?? 0) + 1;
      const verbKey = verb ?? "other";
      (byVerb[verbKey] ??= emptyPaths())[path]++;
      if (target && (byTarget[target] || Object.keys(byTarget).length < MAX_TARGETS)) (byTarget[target] ??= emptyPaths())[path]++;
    },
    setTransport(next) { transport = { ...next, at: now() }; },
    reply({ ms, late }) {
      replies.count++;
      if (ms > 1000) replies.over1s++;
      if (late) replies.late++;
      replies.maxMs = Math.max(replies.maxMs, Math.round(ms));
    },
    disagree(row) {
      disagreementCount++;
      disagreementKinds[row.kind ?? "unknown"] = (disagreementKinds[row.kind ?? "unknown"] ?? 0) + 1;
      disagreements.push({ at: now(), ...row });
      if (disagreements.length > MAX_DISAGREEMENTS) disagreements.shift();
    },
    snapshot() {
      return { v: 1, since, at: now(), transport, totals: { ...totals }, byVerb: structuredClone(byVerb),
        byTarget: structuredClone(byTarget), replies: { ...replies }, disagreementCount,
        disagreementKinds: { ...disagreementKinds }, disagreements: [...disagreements] };
    },
  };
}

/** WHAT: Saves a counter snapshot atomically. WHY: Keeps `amux pulse io` from reading a half-written file. */
export function saveIoSnapshot(path, snapshot) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(snapshot));
  renameSync(temporary, path);
}

/** WHAT: Returns the saved snapshot, or null when the bridge has not written one. WHY: Separates "no data yet" from zero counts. */
export function readIoSnapshot(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

const pad = (value, width) => String(value).padStart(width);
const kinds = (snapshot) => {
  const entries = Object.entries(snapshot.disagreementKinds ?? {});
  return entries.length ? ` (${entries.map(([kind, n]) => `${kind} ${n}`).join(", ")})` : "";
};

/** WHAT: Formats a snapshot as the `amux pulse io` text. WHY: Keeps one owner for the wording Mattias reads. */
export function formatIoSnapshot(snapshot, { now = Date.now(), top = 15 } = {}) {
  if (!snapshot) return "pulse io: no counts yet (the bridge writes them every 10 s after it starts)";
  const minutes = Math.max(1, Math.round((now - snapshot.since) / 60000));
  const t = snapshot.totals;
  const lines = [
    `pulse io · since ${new Date(snapshot.since).toISOString().slice(0, 19)}Z (${minutes} min) · transport ${snapshot.transport.mode} · client ${snapshot.transport.state}${snapshot.transport.reason ? ` (${snapshot.transport.reason})` : ""}`,
    `tmux questions over the client ${t.control} · process starts ${t.process + t.degraded + t.connect} (degraded ${t.degraded}, client ${t.connect}) · shadow checks ${t.shadow} · disagreements ${snapshot.disagreementCount}${kinds(snapshot)}`,
    `client replies ${snapshot.replies?.count ?? 0} · over 1 s ${snapshot.replies?.over1s ?? 0} · slowest ${snapshot.replies?.maxMs ?? 0} ms · late replies dropped ${snapshot.replies?.late ?? 0}`,
    "",
    `${"verb".padEnd(18)}${pad("client", 9)}${pad("process", 9)}${pad("degraded", 10)}${pad("shadow", 8)}`,
  ];
  for (const [verb, row] of Object.entries(snapshot.byVerb).sort((a, b) => (b[1].process + b[1].control) - (a[1].process + a[1].control))) {
    lines.push(`${verb.padEnd(18)}${pad(row.control, 9)}${pad(row.process, 9)}${pad(row.degraded, 10)}${pad(row.shadow, 8)}`);
  }
  lines.push("", `${"pane or session".padEnd(28)}${pad("client", 9)}${pad("process", 9)}`);
  for (const [target, row] of Object.entries(snapshot.byTarget).sort((a, b) => (b[1].process + b[1].control) - (a[1].process + a[1].control)).slice(0, top)) {
    lines.push(`${target.slice(0, 27).padEnd(28)}${pad(row.control, 9)}${pad(row.process, 9)}`);
  }
  for (const row of snapshot.disagreements.slice(-5)) {
    lines.push(`disagreement ${row.verb} ${row.target ?? "-"}${row.kind ? ` (${row.kind}${row.kind === "stdout" ? ` at line ${row.line} of ${row.lines.join("/")}` : ""})` : ""}: exec=${row.process} control=${row.control}`);
  }
  return lines.join("\n");
}
