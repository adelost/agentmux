import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertDreamWritePath, changedDreamMemory, dreamMemoryRoots, readDreamRegular, snapshotDreamMemory } from "./dream-memory-effects.mjs";
import { writeDreamAtomic } from "./dream-commit.mjs";
import { protectedDreamBlocks } from "./dream-memory-guard.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

/** WHAT: Reads a fresh baseline for an explicit historical import. WHY: Separates today's read-only qualification from the missing original curator-effect proof. */
export function beginDreamHistoricalImport({ workspace, owner, inputPath }) {
  const roots = dreamMemoryRoots(workspace, [owner.paneDir]), artifactRoot = dirname(inputPath);
  assertDreamWritePath(inputPath);
  return { roots, artifactRoot, before: snapshotDreamMemory(roots, { artifactRoot }) };
}

/** WHAT: Stores a source-qualified old result as visibly unattested history. WHY: Preserves original failures and cursors instead of manufacturing a successful night or a pre-run snapshot. */
export function finishDreamHistoricalImport({ baseline, workspace, memPath, memoryBefore, input, document, product, proof, dateKey, dry = false }) {
  if (!proof.terminal) throw new Error("dream-historical-terminal-unverified");
  if (hash(readDreamRegular(input.path, 256 * 1024)) !== input.sha256) throw new Error("dream-historical-source-changed");
  if (readFileSync(memPath, "utf8") !== memoryBefore) throw new Error("dream-historical-memory-changed");
  protectedDreamBlocks(memoryBefore);
  if (changedDreamMemory(baseline.before, snapshotDreamMemory(baseline.roots, { artifactRoot: baseline.artifactRoot })).length) {
    throw new Error("dream-historical-qualification-effects-changed");
  }
  const relativePath = `dream/historical/${[dateKey, input.runId].join("-")}.md`, path = join(workspace, "memory", relativePath);
  const content = [
    "<!-- template: reference -->",
    `> summary: Historiskt Dream-underlag för ${dateKey}; ursprunglig effektattest saknas.`,
    "> why: Bevarar en käll- och sessionskvalificerad text utan att kalla den gamla nattkörningen lyckad.",
    "", "**Historisk import · effects-unattested.** Den ursprungliga kuratorns minnesändringar kan inte verifieras i efterhand. Originalfelet och leveranscursors är bevarade.",
    `Ursprunglig modell: ${document.compact.model}, effort ${document.compact.effort}. Ursprunglig session: ${document.compact.sessionId}.`,
    "", product.content.trim(), "",
  ].join("\n");
  const start = `<!-- amux-dream-historical:${dateKey} ${input.runId} -->`, end = `<!-- /amux-dream-historical:${dateKey} ${input.runId} -->`;
  const block = [start, "## Historiskt nattunderlag, effektattest saknas",
    `[Läs hela den historiskt importerade sammanfattningen](${relativePath}).`,
    "Källa, ursprunglig session, modell och slutsvar är kontrollerade. Detta är inte ett lyckat nattkvitto; den ursprungliga effektattesten saknas och originalfelet står kvar.", end].join("\n");
  const at = memoryBefore.indexOf(start), until = memoryBefore.indexOf(end, at);
  const alreadyImported = at >= 0 && until >= at && memoryBefore.slice(at, until + end.length) === block
    && memoryBefore.indexOf(start, at + start.length) < 0 && memoryBefore.indexOf(end, until + end.length) < 0;
  if ((at >= 0 || memoryBefore.includes(end)) && !alreadyImported) throw new Error("dream-historical-reference-changed");
  const auditPath = input.path.replace(/\.json$/u, ".historical-import.json");
  const expected = { version: 1, kind: "historical-import", originalEffects: "unattested", dateKey, runId: input.runId,
    sourceSha256: input.sha256, productSha256: hash(product.content.trim()), artifactSha256: hash(content),
    sessionId: document.compact.sessionId, model: document.compact.model, effort: document.compact.effort,
    terminal: proof.terminal || null, originalStatusPreserved: true, receiptsAdvanced: false };
  let audit;
  try { audit = JSON.parse(readDreamRegular(auditPath, 128 * 1024)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (audit && Object.entries(expected).some(([key, value]) => JSON.stringify(audit[key]) !== JSON.stringify(value))) throw new Error("dream-historical-audit-conflict");
  if (audit?.phase === "committed" && !alreadyImported) throw new Error("dream-historical-reference-removed");
  if (alreadyImported) {
    if (!audit || hash(readDreamRegular(path, 64 * 1024)) !== expected.artifactSha256) throw new Error("dream-historical-artifact-conflict");
  } else if (!dry) {
    assertDreamWritePath(path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const record = audit || { ...expected, phase: "prepared", preparedAt: new Date().toISOString(),
      currentQualificationSnapshotSha256: hash(JSON.stringify(baseline.before)), dayBeforeSha256: hash(memoryBefore) };
    writeDreamAtomic(auditPath, `${JSON.stringify(record)}\n`, { immutable: true });
    writeDreamAtomic(path, content, { immutable: true });
    if (readFileSync(memPath, "utf8") !== memoryBefore) throw new Error("dream-historical-memory-changed");
    writeDreamAtomic(memPath, `${memoryBefore}${memoryBefore.endsWith("\n") ? "" : "\n"}\n${block}\n`);
    audit = record;
  }
  if (!dry && audit?.phase !== "committed") {
    writeDreamAtomic(auditPath, `${JSON.stringify({ ...audit, phase: "committed", confirmedAt: new Date().toISOString(),
      dayObservedSha256: hash(readFileSync(memPath)) })}\n`);
  }
  return { historicalImported: !dry, alreadyImported, dryRun: dry, dateKey, runId: input.runId,
    originalEffects: "unattested", originalStatusPreserved: true, receiptsAdvanced: false, path: memPath, artifact: path, audit: auditPath };
}
