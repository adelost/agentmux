import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { lintMemory } from "./memory-lint.mjs";
import { writeDreamAtomic } from "./dream-commit.mjs";
import { validateDreamSummary } from "./dream-summarizer.mjs";
import { dreamRepairQuestion, preservesRepairFacts, repairHash, repairTarget, repairWarningKey } from "./dream-repair-plan.mjs";

/** WHAT: Checks and stores proposals with real lint before and after writing. WHY: Prevents lost facts, new warnings and overwriting newer notes. */
export function applyDreamMemoryRepairs(workspace, snapshot, plan = { repairs: [] }, { dry = false, now = new Date() } = {}) {
  if (snapshot.version !== 1 || !Array.isArray(snapshot.warnings)) throw Error("dream-repair-snapshot-invalid");
  const applied = [], rejected = [];
  for (const edit of plan.repairs) {
    const warning = snapshot.warnings.find(row => row.id === edit.warningId);
    const reject = reason => rejected.push({ warningId: edit.warningId, reason });
    let path;
    try { path = warning?.editable && repairTarget(workspace, warning.file); }
    catch { /* A vanished target cannot authorize a repair. */ }
    if (!path) { reject("protected-or-unreported-target"); continue; }
    const before = readFileSync(path, "utf8");
    if (repairHash(before) !== warning.sha256) { reject("source-changed"); continue; }
    if (!edit.before || before.split(edit.before).length !== 2) { reject("edit-not-unique"); continue; }
    const after = before.replace(edit.before, edit.after);
    if (!preservesRepairFacts(before, after, warning, workspace, edit)) { reject("fact-line-change"); continue; }
    const prior = lintMemory(workspace, { now });
    const priorKeys = new Set(prior.findings.filter(row => row.severity === "warning").map(repairWarningKey));
    const validate = readText => {
      const result = lintMemory(workspace, { now, ...(readText ? { readText } : {}) });
      const warnings = result.findings.filter(row => row.severity === "warning");
      return !warnings.some(row => repairWarningKey(row) === repairWarningKey(warning))
        && warnings.every(row => priorKeys.has(repairWarningKey(row)));
    };
    if (!validate(file => resolve(file) === path ? after : readFileSync(file, "utf8"))) { reject("lint-not-improved"); continue; }
    if (!dry) {
      if (readFileSync(path, "utf8") !== before || repairTarget(workspace, warning.file) !== path) { reject("source-changed"); continue; }
      const mode = statSync(path).mode & 0o777;
      writeDreamAtomic(path, after); chmodSync(path, mode);
      if (!validate()) {
        if (readFileSync(path, "utf8") !== after) throw Error("dream-repair-rollback-conflict");
        writeDreamAtomic(path, before); chmodSync(path, mode);
        reject("post-write-lint-not-improved"); continue;
      }
    }
    applied.push({ warningId: edit.warningId, file: warning.file, beforeSha256: repairHash(before), afterSha256: repairHash(after), dry });
  }
  const remaining = lintMemory(workspace, { now }).findings.filter(row => row.severity === "warning");
  const unresolved = snapshot.warnings.filter(warning => !applied.some(row => row.warningId === warning.id)
    && remaining.some(row => repairWarningKey(row) === repairWarningKey(warning)));
  const maintenance = { daily_compact: "existing nightly archive", memory_unbanked: "existing nightly memory bank" };
  const followups = unresolved.filter(row => maintenance[row.code]).map(row => ({ ...row, actor: maintenance[row.code] }));
  const questions = unresolved.filter(row => !maintenance[row.code]).map(dreamRepairQuestion);
  if (snapshot.omitted) questions.push(`${snapshot.omitted} ytterligare minnesvarningar finns i amux memory lint. Vilka behöver förtydligas?`);
  return { applied, rejected, questions, followups, dry };
}

/** WHAT: Normalizes one proven curator product and preserves its original proposal as evidence. WHY: Recovery and health read the same final human summary without a second model turn. */
export function finishDreamMemoryRepairs({ workspace, input, product, dry = false }) {
  const bytes = readFileSync(input.path);
  if (repairHash(bytes) !== input.sha256) throw Error("dream-repair-input-changed");
  const document = JSON.parse(bytes), snapshot = document.payload?.memoryRepair;
  if (!snapshot?.warnings?.length && !snapshot?.omitted) {
    if (product.repairPlan?.repairs?.length) throw Error("dream-repair-unrequested-plan");
    return product;
  }
  const receiptPath = input.outputPath.replace(/\.summary\.md$/u, ".memory-repair.json");
  const original = readFileSync(input.outputPath, "utf8");
  if (existsSync(receiptPath)) {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (receipt.version !== 1 || receipt.sourceSha256 !== input.sha256
      || repairHash(receipt.content) !== receipt.normalizedSha256 || !validateDreamSummary(receipt.content).ok
      || ![receipt.originalSha256, receipt.normalizedSha256].includes(repairHash(original.trim()))) {
      throw Error("dream-repair-receipt-conflict");
    }
    if (!dry && original.trim() !== receipt.content) writeDreamAtomic(input.outputPath, `${receipt.content}\n`);
    return { ...product, content: receipt.content, memoryRepair: receipt.report };
  }
  if (Buffer.byteLength(product.content) > 4096 || product.content.split(/\r?\n/u).filter(line => line.trim()).length > 30) {
    throw Error("dream-repair-summary-reserve-exceeded");
  }
  if (!dry) writeDreamAtomic(input.outputPath.replace(/\.summary\.md$/u, ".curator.md"), original, { immutable: true });
  const report = applyDreamMemoryRepairs(workspace, snapshot, product.repairPlan, { dry, now: new Date(document.createdAt) });
  const content = [product.content,
    `\nMinneskontroll: ${report.applied.length} ${dry ? "föreslagna" : "validerade"} rättning(ar), ${report.rejected.length} avvisade.`,
    ...report.followups.map(row => `- ${row.file}: ${row.message}. Actor: ${row.actor}.`),
    ...(report.questions.length ? ["\n### Frågor till Mattias", ...report.questions.map(question => `- ${question}`)] : []),
  ].join("\n").replace(/<!--\s*\/?amux-/giu, "&lt;!-- amux-");
  const valid = validateDreamSummary(content);
  if (!valid.ok) throw Error(`dream-repair-summary-invalid:${valid.reason}`);
  if (!dry) {
    writeDreamAtomic(receiptPath, JSON.stringify({ version: 1, sourceSha256: input.sha256,
      originalSha256: repairHash(original.trim()), normalizedSha256: repairHash(valid.content), content: valid.content,
      plan: product.repairPlan || null, report }) + "\n");
    writeDreamAtomic(input.outputPath, `${valid.content}\n`);
  }
  return { ...product, ...valid, memoryRepair: report };
}
