import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { lintMemory } from "./memory-lint.mjs";

/** WHAT: Returns the exact candidate hash. WHY: Prevents old curator proposals from overwriting newer manual edits. */
export const repairHash = text => createHash("sha256").update(text).digest("hex");
/** WHAT: Returns the original lint finding identity. WHY: Prevents proposals from granting themselves a new file target. */
export const repairWarningKey = warning => JSON.stringify([warning.file, warning.code, warning.message]);
const EDITABLE = new Set(["summary_missing", "why_missing", "broken_link"]);

/** WHAT: Checks regular non-policy memory paths with no symlink component. WHY: Keeps journals, daily/Dream history and files outside the workspace immutable to repairs. */
export function repairTarget(workspace, file) {
  if (!/^(?:MEMORY\.md|memory\/people\.md|memory\/(?:references|people)\/[^/]+\.md)$/u.test(file || "")
    || file.includes("..") || /TEMPLATE/iu.test(file)) return null;
  let path = resolve(workspace);
  for (const part of file.split("/")) {
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink()) return null;
  }
  return lstatSync(path).isFile() && path.startsWith(`${resolve(workspace)}${sep}`) ? path : null;
}

/** WHAT: Reads bounded findings and exact target hashes for normal Dream input. WHY: Keeps warning repair inside the same model run and the existing linter. */
export function readDreamMemoryWarnings(workspace, { now = new Date() } = {}) {
  if (!existsSync(join(workspace, "memory"))) return { version: 1, warnings: [], omitted: 0 };
  const warnings = lintMemory(workspace, { now }).findings.filter(row => row.severity === "warning");
  const selected = [];
  for (const row of warnings) {
    let path = null;
    try { path = repairTarget(workspace, row.file); } catch { /* Missing/non-file findings are questions, not writable targets. */ }
    const editable = !!path && EDITABLE.has(row.code) && !row.message.includes("frontmatter") && lstatSync(path).size <= 131072;
    const warning = { id: repairHash(repairWarningKey(row)), code: row.code, file: row.file, message: row.message,
      editable, ...(editable ? { sha256: repairHash(readFileSync(path)) } : {}) };
    if (selected.length >= 24 || Buffer.byteLength(JSON.stringify([...selected, warning])) > 4096) continue;
    selected.push(warning);
  }
  return { version: 1, omitted: warnings.length - selected.length, warnings: selected };
}

/** WHAT: Decodes only the optional bounded footer. WHY: Prevents proposal JSON from becoming human summary text or executable instructions. */
export function decodeDreamRepairOutput(text) {
  if (Buffer.byteLength(text) > 48 * 1024) throw Error("dream-repair-output-too-large");
  const marker = "\n```amux-memory-repairs\n", at = text.indexOf(marker);
  if (at < 0) return { content: text };
  if (at !== text.lastIndexOf(marker) || !text.endsWith("\n```")) throw Error("dream-repair-footer-invalid");
  const plan = JSON.parse(text.slice(at + marker.length, -4));
  if (plan?.version !== 1 || Object.keys(plan).some(key => !["version", "repairs"].includes(key))
    || !Array.isArray(plan.repairs) || plan.repairs.length > 12) throw Error("dream-repair-plan-invalid");
  for (const edit of plan.repairs) {
    if (!edit || Object.keys(edit).some(key => !["warningId", "before", "after"].includes(key))
      || !/^[a-f0-9]{64}$/u.test(edit.warningId) || typeof edit.before !== "string" || !edit.before
      || typeof edit.after !== "string" || Buffer.byteLength(edit.before + edit.after) > 16384) throw Error("dream-repair-edit-invalid");
  }
  return { content: text.slice(0, at).trim(), repairPlan: plan };
}

function factLines(text) {
  return text.split("\n").filter(line => line.trim() && !/^> (?:summary|why):/u.test(line));
}

function existingReference(workspace, file) {
  if (!/^memory\/(?:[^/]+\/)*[^/]+\.md$/u.test(file) || file.split("/").includes("..")) return false;
  let path = resolve(workspace);
  for (const part of file.split("/")) {
    path = join(path, part);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return false;
  }
  return lstatSync(path).isFile();
}

/** WHAT: Checks exact ordered non-metadata lines around a proposed repair. WHY: Prevents history rewrites, reassigned facts and invented missing lessons. */
export function preservesRepairFacts(before, after, warning, workspace, edit) {
  if (warning.code === "broken_link") {
    const old = warning.message.replace(/^broken link: /u, "");
    const links = [...edit.after.matchAll(/`(memory\/[^`\n]+\.md)`/gu)].map(match => match[1]);
    const next = links.find(file => file !== old && existingReference(workspace, file));
    if (!next || edit.before.replaceAll(`\`${old}\``, `\`${next}\``) !== edit.after) return false;
    before = before.replaceAll(`\`${old}\``, `\`${next}\``);
  }
  return JSON.stringify(factLines(before)) === JSON.stringify(factLines(after));
}

/** WHAT: Names the unresolved human input. WHY: Prevents a plausible invented lesson from replacing Isabella's missing fact. */
export function dreamRepairQuestion(warning) {
  return warning.code === "people_entry_lesson"
    ? `Vilken lärdom vill Mattias spara för ${warning.message.split(":")[0]}?`
    : `${warning.file || "Minneskontrollen"}: ${warning.message}. Hur ska detta rättas utan att ändra fakta?`;
}
