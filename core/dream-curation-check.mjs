import { existsSync, readFileSync } from "node:fs";
import { readDreamCurationProof } from "./dream-curation-proof.mjs";
import { readDreamOwnerResult } from "./dream-owner.mjs";
import { readDreamRegular, verifyDreamMemoryEffects } from "./dream-memory-effects.mjs";
import { judgeDreamMemory } from "./dream-memory-guard.mjs";
import { protectedDreamBlocks } from "./dream-memory-guard.mjs";
import { writeDreamAtomic } from "./dream-commit.mjs";
import { freezeDreamCare } from "./dream-care-workspace.mjs";

/** WHAT: Reads the completed product and checks its original proof and memory effects. WHY: Separates curator acceptance from controller repairs and commit authority. */
export async function checkDreamCuration({ owner, sessionId, prompt, dateKey, input, memPath, quality, workspace, memoryBefore, getProof = readDreamCurationProof }) {
  await getProof({ owner, sessionId, prompt, dateKey, runId: input.runId, memPath, quality });
  const document = JSON.parse(readDreamRegular(input.path, 256 * 1024));
  const product = readDreamOwnerResult(existsSync(input.outputPath) ? input.outputPath : input.modelOutputPath || input.outputPath, dateKey, input.runId, owner, input.sha256);
  if (!product.ok) throw new Error(`dream-owner-product-invalid:${product.reason}`);
  if (document.memoryCare) {
    if (document.memoryCare.runtimeAttested !== true) throw Error("dream-care-runtime-unattested");
    writeDreamAtomic(input.outputPath, product.content + "\n", { immutable: true });
    const memoryCare = freezeDreamCare(input);
    const judgeConcurrentNotes = (_before, current) => ({ ok: JSON.stringify(protectedDreamBlocks(memoryBefore)) === JSON.stringify(protectedDreamBlocks(current)), reason: "dream-marker" });
    if (!judgeConcurrentNotes(memoryBefore, readFileSync(memPath, "utf8")).ok) throw Error("daily-memory-changed-during-dream:dream-marker");
    return { product, judgeConcurrentNotes, memoryCare };
  }
  verifyDreamMemoryEffects({ inputPath: input.path, inputSha256: input.sha256,
    descriptor: document.memoryGuard?.effects, workspace, paneDirs: [owner.paneDir].filter(Boolean) });
  const judgeConcurrentNotes = (_before, current) => judgeDreamMemory(memoryBefore, current);
  const verdict = judgeConcurrentNotes(memoryBefore, readFileSync(memPath, "utf8"));
  if (!verdict.ok) throw Error(`daily-memory-changed-during-dream:${verdict.reason}`);
  return { product, judgeConcurrentNotes };
}
