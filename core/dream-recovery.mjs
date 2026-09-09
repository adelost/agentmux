// Finish an already-curated run without compacting, prompting or waking a pane.
import { readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { loadConfig } from "../cli/config.mjs";
import { defaultWorkspace } from "./runtime-defaults.mjs";
import { dreamOwnerPrompt, readDreamOwnerQuality, resolveDreamCandidates } from "./dream-owner.mjs";
import { defaultDreamReceiptPath, isDreamActivityTurn, readDreamReceipts } from "./dream-eligibility.mjs";
import { readDreamSuccess } from "./dream-health.mjs";
import { waitForDreamOwnerResult } from "./dream-result.mjs";
import { resumeDreamCommit } from "./dream-commit.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

/** WHAT: Checks and finishes an existing Dream run. WHY: Preserves exact input, session, final reply and pre-write memory fences without buying another model turn. */
export async function recoverDreamRun(ctx, flags, { commit, getQuality = readDreamOwnerQuality } = {}) {
  const path = resolve(String(flags.recover));
  const name = /^(\d{4}-\d{2}-\d{2})-([0-9a-f-]{36})\.json$/u.exec(basename(path));
  if (!name || statSync(path).size > 256 * 1024) throw new Error("dream-recovery-invalid-input");
  const bytes = readFileSync(path);
  const sha256 = hash(bytes);
  if (sha256 !== flags["source-sha256"]) throw new Error("dream-recovery-source-hash-mismatch");
  const document = JSON.parse(bytes);
  const dateKey = name[1], runId = name[2];
  const now = new Date();
  if (document.schemaVersion !== 1 || document.dateKey !== dateKey
      || !Number.isFinite(Date.parse(document.createdAt)) || Date.parse(document.createdAt) > now.getTime()
      || document.compact?.boundary !== true || !document.compact.sessionId
      || !Array.isArray(document.payload?.panes) || !document.payload.panes.length
      || !Array.isArray(document.omitted) || !Array.isArray(document.unreadable)) throw new Error("dream-recovery-invalid-input");
  const workspace = resolve(flags.workspace || process.env.OPENCLAW_WORKSPACE || defaultWorkspace());
  if (document.workspace && resolve(document.workspace) !== workspace) throw new Error("dream-recovery-workspace-mismatch");
  const memPath = join(workspace, "memory", `${dateKey}.md`);
  const success = readDreamSuccess(workspace, dateKey, { home: homedir(), now });
  if (success.ok && success.runId === runId) return { alreadyCommitted: true, runId, dateKey, path: memPath };
  const expectedMemory = document.memoryBeforeSha256 || flags["memory-sha256"];
  if (!/^[a-f0-9]{64}$/u.test(expectedMemory || "")) throw new Error("dream-recovery-pre-run-memory-hash-required");
  if (document.memoryBeforeSha256 && flags["memory-sha256"] && flags["memory-sha256"] !== document.memoryBeforeSha256) {
    throw new Error("dream-recovery-pre-run-memory-hash-mismatch");
  }
  const resumed = resumeDreamCommit({ path, sha256, document, workspace, memPath, dateKey, runId,
    expectedMemory, dry: !!flags.dry });
  if (resumed) return resumed;
  const memoryBefore = readFileSync(memPath, "utf8");
  if (hash(memoryBefore) !== expectedMemory) throw new Error("dream-recovery-memory-changed");
  const owner = resolveDreamCandidates(loadConfig(ctx.configPath)).find(candidate =>
    candidate.agent === document.owner?.agent && candidate.pane === document.owner.pane && candidate.engine === document.owner.engine);
  if (!owner) throw new Error("dream-recovery-owner-not-configured");
  const verifySession = async () => {
    const quality = await getQuality(owner, { captureScreen: (agent, pane) => ctx.agent.captureScreen(agent, pane) });
    if (quality?.sessionId !== document.compact.sessionId || quality?.model !== document.compact.model
        || quality?.effort !== document.compact.effort || /haiku/iu.test(quality?.model || "")
        || !quality?.effort || quality.effort.toLowerCase() === "low") throw new Error("dream-recovery-session-quality-mismatch");
  };
  await verifySession();
  const input = { path, outputPath: path.replace(/\.json$/u, ".summary.md"), runId, sha256, bytes: bytes.length,
    memoryFormat: document.memoryFormat };
  const previous = new Date(`${dateKey}T12:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const prompt = dreamOwnerPrompt({ owner, input, memPath,
    previousMemPath: join(workspace, "memory", `${previous.toISOString().slice(0, 10)}.md`), dateKey,
    included: document.payload.panes.length, omitted: document.omitted.length, unreadable: document.unreadable.length });
  const product = await waitForDreamOwnerResult({ ctx, owner, prompt, outputPath: input.outputPath, dateKey, runId,
    sourceSha256: sha256, attempts: 1 });
  if (!product.ok) throw new Error(`dream-recovery-product-invalid:${product.reason}`);
  const included = document.payload.panes.map(source => {
    const ref = /^([a-zA-Z0-9_-]+):(\d+)$/u.exec(source.pane);
    if (!ref || !Array.isArray(source.turns)) throw new Error("dream-recovery-invalid-source");
    const turns = source.turns.filter(turn => isDreamActivityTurn(turn.user));
    if (turns.some(turn => !Number.isFinite(Date.parse(turn.at)))) throw new Error("dream-recovery-invalid-cursor");
    return { agent: ref[1], pane: Number(ref[2]), turns: turns.length, activityCursor: turns.at(-1)?.at };
  });
  const receiptTargets = included.filter(source => source.turns);
  const receiptPath = defaultDreamReceiptPath(), receipts = readDreamReceipts(receiptPath);
  for (const source of receiptTargets) {
    const previousCursor = receipts.panes[`${source.agent}:${source.pane}`]?.activityCursor;
    if (previousCursor && Date.parse(previousCursor) > Date.parse(source.activityCursor)) throw new Error("dream-recovery-newer-receipt-exists");
  }
  await verifySession();
  if (hash(readFileSync(memPath)) !== expectedMemory) throw new Error("dream-recovery-memory-changed");
  if (!flags.dry) commit({ memPath, memoryBefore, product, dateKey, included, omitted: document.omitted,
    receipts, receiptTargets, receiptPath, now, input, unreadable: document.unreadable });
  return { recovered: !flags.dry, dryRun: !!flags.dry, dateKey, runId, path: memPath,
    included: included.length, receipts: receiptTargets.length, unreadable: document.unreadable.length };
}
