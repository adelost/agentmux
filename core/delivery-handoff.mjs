// A blocked handoff returns to its recorded sender, never to a fleet-wide manager.
import { parseSenderAddress } from "./sender-detect.mjs";

const HANDOFF_STALL_MS = 10 * 60_000;
const ALERT_RETRY_MS = 60_000;

/** WHAT: Names the observed delivery boundary. WHY: Prevents installation failures from being diagnosed as project checkout faults. */
export function deliveryBlockerDetail(job) {
  const reason = String(job?.lastReason || "");
  if (reason.startsWith("wake-refused:identity-")) {
    return "AMUX-installationen kan inte verifieras. Felet gäller inte projektets arbetskopia. "
      + "Kontrollera amux doctor och installerad release; en ny feature-worktree löser inte detta";
  }
  if (/^wake-refused:memory-(critical|blocked|reserve-floor)/u.test(reason)) {
    return "värden saknar säker minnesmarginal för att starta panelen";
  }
  if (reason.startsWith("wake-refused:guard-state-stale")) return "minnesvaktens mätning är för gammal";
  if (reason.startsWith("wake-refused:")) return "den adresserade agentprocessen kunde inte startas";
  return "panelen är inte redo för säker leverans; composern får inte skrivas över";
}

/** WHAT: Maps an unreceived handoff to its original owner. WHY: Prevents queue age or an ambiguous submit from authorizing reassignment. */
export function blockedHandoffSender(job, nowMs) {
  const sender = parseSenderAddress(job?.metadata?.sender);
  if (!sender || sender.key === `${job.agentName}:${job.pane}` || job.source !== "cli"
      || job.kind !== "prompt" || job.status !== "pending" || job.draftOwned || job.submitFenceAt
      || job.submittedAt || job.cancelRequestStatus || job.metadata?.submittedRecoveryAt
      || job.metadata?.submittedRecoveryKind || job.metadata?.deliveryTransport === "native"
      || job.metadata?.handoffNoticeJobId || !job.lastReason) return null;
  const park = job.metadata?.preSubmitPark;
  const attempts = Number(job.attempts || 0) + Number(park?.attempts || 0);
  const firstAttemptAt = Number(park?.firstAttemptAt || job.firstAttemptAt || 0);
  const failedWakes = job.lastReason.startsWith("wake-refused:") && attempts >= 2;
  const timedOut = attempts > 0 && firstAttemptAt > 0 && nowMs - firstAttemptAt >= HANDOFF_STALL_MS;
  return (failedWakes || timedOut) && Number(job.metadata?.handoffNoticeNextAttemptAt || 0) <= nowMs
    ? sender : null;
}

/** WHAT: Dispatches one recovery notice through the existing durable transport. WHY: Keeps a real stall with its sender without duplicating or automatically reassigning the original task. */
export async function reportBlockedHandoffs({ agentName, pane, queue, now, exactEcho, acknowledge, log, agent }) {
  for (let job of queue.list(agentName, pane)) {
    if (!blockedHandoffSender(job, now())) continue;
    if (typeof agent?.isNativeTarget === "function") {
      try { if (agent.isNativeTarget(agentName, pane)) continue; }
      catch { continue; } // Unknown transport cannot prove a pre-submit handoff.
    }
    if (typeof exactEcho === "function" && await exactEcho(job)) {
      await acknowledge?.(job, "echo-before-handoff-notice");
      continue;
    }
    job = queue.read(agentName, pane, job.id);
    const sender = blockedHandoffSender(job, now());
    if (!sender) continue;
    const observedAt = new Date(now()).toISOString();
    const text = `[AMUX leveransstopp · observerat ${observedAt}]\n`
      + `Din uppgift till ${agentName}:${pane} har inte nått mottagaren. Jobb ${job.id}.\n`
      + `${deliveryBlockerDetail(job)}.\n`
      + `Originalet ligger kvar oförändrat i den privata köfilen ${job.path}.\n`
      + "Läs först jobbets aktuella status och den senaste användarordern. Om det redan levererats, "
      + "avbrutits eller ersatts, återuppta inte gammalt arbete. Ett submitted/submitting-jobb får inte skickas om.\n"
      + "Om samma uppgift fortfarande är blockerad före submit: åtgärda den konkreta orsaken inom ditt mandat. "
      + "Vid omfördelning, begär vanlig amux queue cancel och verifiera NOT SENT innan en enda ny handoff "
      + "till en tillåten, ledig ägare. Byt inte modell, skapa inte arbetskopior och väck inte fler paneler "
      + "bara på grund av detta larm. Köad är inte mottagen; kontrollera kvittot.";
    try {
      const notice = queue.enqueue({
        agentName: sender.session, pane: sender.pane, source: "delivery-recovery", text,
        idempotencyKey: `handoff-stall:${agentName}:${pane}:${job.id}`,
        metadata: { handoffFor: { agentName, pane, jobId: job.id, observedAt } },
      });
      queue.update(job, { metadata: { handoffNoticeJobId: notice.id,
        handoffNoticeNextAttemptAt: null, handoffNoticeLastReason: null } });
    } catch (error) {
      queue.update(job, { metadata: { handoffNoticeNextAttemptAt: now() + ALERT_RETRY_MS,
        handoffNoticeLastReason: error.message } });
      log(`delivery handoff notice pending for ${job.id}: ${error.message}`);
    }
  }
}
