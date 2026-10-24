import { readFileSync } from "node:fs";
import { readDreamCurationProof } from "./dream-curation-proof.mjs";
import { readDreamOwnerResult } from "./dream-owner.mjs";
import { readDreamRegular, verifyDreamMemoryEffects } from "./dream-memory-effects.mjs";
import { judgeDreamMemory } from "./dream-memory-guard.mjs";

/** WHAT: Reads the completed product and checks its original proof and memory effects. WHY: Separates curator acceptance from controller repairs and commit authority. */
export async function checkDreamCuration({ owner, sessionId, prompt, dateKey, input, memPath, quality, workspace, memoryBefore, sandboxProof = null, onTerminal = () => {}, getProof = readDreamCurationProof }) {
  const proof = await getProof({ owner, sessionId, prompt, dateKey, runId: input.runId, memPath, quality, sandbox: !!input.sandbox });
  onTerminal();
  if (proof.sandboxDenied) throw Error("dream-sandbox-denied");
  const product = readDreamOwnerResult(input.outputPath, dateKey, input.runId, owner, input.sha256);
  if (!product.ok) throw new Error(`dream-owner-product-invalid:${product.reason}`);
  const document = JSON.parse(readDreamRegular(input.path, 256 * 1024));
  verifyDreamMemoryEffects({ inputPath: input.path, inputSha256: input.sha256,
    descriptor: document.memoryGuard?.effects, workspace, paneDirs: [owner.paneDir].filter(Boolean), sandboxProof });
  const judgeConcurrentNotes = (_before, current) => judgeDreamMemory(memoryBefore, current);
  const verdict = judgeConcurrentNotes(memoryBefore, readFileSync(memPath, "utf8"));
  if (!verdict.ok) throw Error(`daily-memory-changed-during-dream:${verdict.reason}`);
  return { product, judgeConcurrentNotes };
}
