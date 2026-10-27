import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createState } from "../core/state.mjs";
import { splitMessage, chunkAttachments } from "../lib.mjs";
import { qualifyClaims } from "../core/claim-corpus.mjs";
import { claimRepoPaths } from "../core/claim-repos.mjs";
import { createClaimEvaluator } from "../core/claim-evaluator.mjs";
import { claimAlgorithm } from "../core/claim-version.mjs";
import { createClaimGuard } from "./claim-guard.mjs";

/** WHAT: Builds the shared reply guard for both watchers. WHY: Prevents unqualified enforcement and keeps hold ownership independent of inbound delivery. */
export function createClaimGuardRuntime({ discord, broker, configPath, dir = join(homedir(), ".agentmux/claim-guard"), env = process.env }) {
  if (!discord || env.AMUX_CLAIM_GUARD === "off") return null;
  try { return buildClaimGuard({ discord, broker, configPath, dir, env }); }
  catch (error) {
    console.warn(`claim guard disabled: initialization unavailable (${error.message}); human delivery remains enabled`);
    return null;
  }
}

function buildClaimGuard({ discord, broker, configPath, dir, env }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = row => appendFileSync(join(dir, "decisions.jsonl"), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  const state = createState(join(dir, "state.json"));
  let qualification = null;
  try { qualification = JSON.parse(readFileSync(join(dir, "qualification.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") console.warn(`claim qualification unreadable: ${error.message}`); }
  const algorithm = claimAlgorithm();
  const qualified = qualification?.algorithm === algorithm && qualification.today?.algorithm === algorithm
    && qualifyClaims(qualification.today, qualification.heldOut);
  const requested = env.AMUX_CLAIM_GUARD || "shadow";
  if (requested === "enforce" && !qualified) record({ event: "enforcement-refused-unqualified", at: new Date().toISOString() });
  const mode = () => env.AMUX_CLAIM_GUARD === "off" ? "off"
    : env.AMUX_CLAIM_GUARD === "enforce" && qualified ? "enforce" : "shadow";
  const evaluator = createClaimEvaluator(claimRepoPaths(configPath));
  return createClaimGuard({ state, mode, check: evaluator, record,
    sendHeld: async reply => {
      const chunks = splitMessage(reply.text), files = chunkAttachments(reply.files || []);
      for (let i = 0; i < chunks.length; i++) await discord.send(reply.channelId,
        i === 0 && files.length ? { content: chunks[i], files: files[0] } : chunks[i], { kind: "reply" });
      for (const group of files.slice(1)) await discord.send(reply.channelId, { files: group }, { kind: "file" });
    },
    requestCorrection: (reply, sentences) => {
      const [agentName, pane] = reply.paneKey.split(":");
      return broker.enqueue({ agentName, pane: Number(pane), source: "claim-guard", kind: "prompt",
        idempotencyKey: `claim-guard:${reply.turnId}`,
        text: `[amux claim-guard correction for ${reply.turnId}]\nHeld: these sentences state a fact without a source:\n${sentences.map(s => `- ${s.text}`).join("\n")}\nAdd file:line, a receipt path or command with output, or mark 'inte kontrollerat'. Send one corrected answer. If the human has already written again, follow that message instead.` });
    },
    dropCorrection: reply => {
      if (!reply.requestId) return;
      const job = broker.queue.findById(reply.requestId);
      if (!job || job.submittedAt || job.status !== "pending") return;
      broker.queue.requestCancellation(job.id, { reason: "Human continued or corrected reply arrived; claim correction no longer needed", requestedBy: "claim-guard" });
    },
  });
}
