// Durable completion intent, written only after the curator's terminal proof.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultDreamReceiptPath, isDreamActivityTurn, readDreamReceipts, recordDreamReceipts } from "./dream-eligibility.mjs";
import { readDreamOwnerResult } from "./dream-owner.mjs";
import { dreamSnapshotReference, publishDreamSnapshot, verifyDreamSnapshot } from "./dream-snapshot.mjs";
import { upsertDreamSummary } from "./dream-summarizer.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const intentPath = input => input.replace(/\.json$/u, ".commit.json");
const syncDirectory = path => {
  const fd = openSync(dirname(path), "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

/** WHAT: Stores one durable Dream file atomically. WHY: Prevents a host restart from losing an acknowledged rename. */
export function writeDreamAtomic(path, content, { immutable = false } = {}) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    if (immutable) {
      try { linkSync(temporary, path); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (readFileSync(path, "utf8") !== content) throw new Error("dream-commit-intent-conflict");
      }
      unlinkSync(temporary);
    } else renameSync(temporary, path);
    syncDirectory(path);
  } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; } }
}

/** WHAT: Stores the verified commit intent before changing daily memory. WHY: Preserves terminal proof across the block/cursor/sentinel crash gaps without another model turn. */
export function commitDreamProduct({ memPath, memoryBefore, product, dateKey, included, omitted,
  receipts, receiptTargets = included, receiptPath = defaultDreamReceiptPath(), now,
  recordReceipts = recordDreamReceipts, input, unreadable = [] }) {
  const check = () => {
    if (readFileSync(memPath, "utf8") !== memoryBefore) throw new Error("dream-owner-touched-memory-before-controller-commit");
  };
  check();
  const snapshot = publishDreamSnapshot(memPath, product.content, dateKey, included, omitted);
  if (input) {
    if (hash(readFileSync(input.path)) !== input.sha256 || input.runId !== snapshot.runId
        || input.sha256 !== snapshot.sourceSha) throw new Error("dream-commit-input-mismatch");
    const record = { version: 1, dateKey, runId: input.runId, sourceSha256: input.sha256,
      memPath: resolve(memPath), memoryBeforeSha256: hash(memoryBefore), block: snapshot.block,
      productSha256: hash(product.content.trim()), receiptPath: resolve(receiptPath),
      receiptTargets: receiptTargets.map(({ agent, pane, turns, activityCursor }) => ({ agent, pane, turns, activityCursor })),
      included: included.length, unreadable: unreadable.length, committedAt: now.toISOString() };
    writeDreamAtomic(intentPath(input.path), `${JSON.stringify(record)}\n`, { immutable: true });
  }
  check();
  writeDreamAtomic(memPath, upsertDreamSummary(memoryBefore, dateKey, snapshot.block));
  recordReceipts(receipts, receiptTargets, { path: receiptPath, dateKey, now });
}

/** WHAT: Stores the result of a previously verified controller intent. WHY: Preserves newer manual notes while refusing changed products, blocks, cursors or workspaces. */
export function resumeDreamCommit({ path, sha256, document, workspace, memPath, dateKey, runId, expectedMemory, dry = false }) {
  let record;
  try {
    if (statSync(intentPath(path)).size > 128 * 1024) throw new Error("dream-commit-intent-too-large");
    record = JSON.parse(readFileSync(intentPath(path), "utf8"));
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const product = readDreamOwnerResult(path.replace(/\.json$/u, ".summary.md"), dateKey, runId, document.owner, sha256);
  const reference = dreamSnapshotReference(record.block, dateKey);
  if (record.version !== 1 || record.runId !== runId || record.dateKey !== dateKey || record.sourceSha256 !== sha256
      || record.memPath !== resolve(memPath) || record.receiptPath !== resolve(defaultDreamReceiptPath())
      || record.memoryBeforeSha256 !== expectedMemory || !product.ok
      || hash(product.content) !== record.productSha256 || reference?.runId !== runId || reference.sourceSha !== sha256
      || !verifyDreamSnapshot(workspace, dateKey, reference, product.content)
      || !Number.isFinite(Date.parse(record.committedAt)) || Date.parse(record.committedAt) > Date.now()
      || record.included !== document.payload.panes.length || record.unreadable !== document.unreadable.length
      || !Array.isArray(record.receiptTargets)) throw new Error("dream-commit-intent-invalid");
  const receipts = readDreamReceipts(record.receiptPath), seen = new Set();
  const expectedKeys = document.payload.panes.filter(source => source.turns.some(turn => isDreamActivityTurn(turn.user)))
    .map(source => source.pane);
  if (record.receiptTargets.length !== expectedKeys.length) throw new Error("dream-commit-receipts-invalid");
  for (const target of record.receiptTargets) {
    const key = `${target.agent}:${target.pane}`;
    const source = document.payload.panes.find(pane => pane.pane === key);
    if (seen.has(key) || !expectedKeys.includes(key) || !source || target.activityCursor !== source.turns.at(-1)?.at
        || !Number.isFinite(Date.parse(target.activityCursor)) || !Number.isSafeInteger(target.turns) || target.turns < 1) {
      throw new Error("dream-commit-receipts-invalid");
    }
    seen.add(key);
    if (Date.parse(receipts.panes[key]?.activityCursor) > Date.parse(target.activityCursor)) {
      throw new Error("dream-recovery-newer-receipt-exists");
    }
  }
  const before = readFileSync(memPath, "utf8"), start = `<!-- amux-dream-summary:${dateKey} -->`;
  const end = `<!-- /amux-dream-summary:${dateKey} -->`;
  const at = before.indexOf(start), until = before.indexOf(end, at);
  const alreadyWritten = at >= 0 && until >= at && before.slice(at, until + end.length) === record.block
    && before.indexOf(start, at + start.length) < 0;
  if (!alreadyWritten && hash(before) !== record.memoryBeforeSha256) throw new Error("dream-recovery-memory-changed");
  if (!dry) {
    if (!alreadyWritten) writeDreamAtomic(memPath, upsertDreamSummary(before, dateKey, record.block));
    recordDreamReceipts(receipts, record.receiptTargets, { path: record.receiptPath, dateKey, now: new Date(record.committedAt) });
  }
  return { recovered: !dry, dryRun: dry, commitReceipt: true, dateKey, runId, path: memPath,
    included: record.included, receipts: record.receiptTargets.length, unreadable: record.unreadable };
}
