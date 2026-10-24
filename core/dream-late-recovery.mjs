import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readDreamOwnerResult } from "./dream-owner.mjs";
import { readDreamSuccess } from "./dream-health.mjs";

// WHAT: Returns the checked recovery outcome of one late curator product. WHY: Prevents a failed wait from abandoning a completed night or sending a second model prompt.
export async function recoverLateDream({ workspace, home, dateKey, dry = false, run,
  success = readDreamSuccess,
}) {
  const root = join(home, ".agentmux", "dream-input");
  let names;
  try { names = readdirSync(root); }
  catch (error) { if (error.code === "ENOENT") return { skipped: "no-late-product" }; throw error; }
  const candidates = [];
  for (const name of names) {
    const match = new RegExp(`^${dateKey}-([0-9a-f-]{36})\\.json$`, "u").exec(name);
    if (!match) continue;
    const path = join(root, name), bytes = readFileSync(path), document = JSON.parse(bytes);
    if (document.workspace !== resolve(workspace) || document.dateKey !== dateKey || !document.owner) continue;
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    const product = readDreamOwnerResult(document.outputPath || path.replace(/\.json$/u, ".summary.md"), dateKey, match[1], document.owner, sourceSha256);
    if (product.ok) candidates.push({ path, sourceSha256, runId: match[1] });
  }
  if (candidates.length !== 1) return { skipped: candidates.length ? "ambiguous-late-products" : "no-late-product" };
  const candidate = candidates[0];
  if (dry) return { recoverable: true, dateKey, ...candidate };
  const exitCode = await run(["dream", "--recover", candidate.path, "--source-sha256", candidate.sourceSha256, "--workspace", workspace]);
  const digest = success(workspace, dateKey, { home });
  return { recovered: exitCode === 0 && digest.ok && digest.runId === candidate.runId, dateKey, ...candidate, exitCode, digest };
}
