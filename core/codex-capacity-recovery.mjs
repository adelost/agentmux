import { codexThreadOfRollout, codexTurnError, codexLastPrompt } from "./codex-refusal-notice.mjs";
import { selectedCodexProfile, codexModelOverride } from "./codex-profiles.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { findBlockingPrompt } from "./dismiss.mjs";
import { parseJsonlText, readTailWindow } from "./jsonl-reader.mjs";

/** DTO: Durable per-pane bounded capacity episodes. */
export const CAPACITY_STATE_KEY = "codex_capacity_recovery";
/** DTO: The only automatic prompt, unchanged across queue retries. */
export const CAPACITY_CONTINUE_TEXT = "Modellen var tillfälligt full. Fortsätt där du var.";
const RETRY_AT_MS = [2, 5, 10].map(minutes => minutes * 60_000);
const SOURCE = "codex-capacity-recovery";

/** WHAT: Checks an explicit provider capacity error. WHY: Prevents limits and unrelated errors from consuming capacity retries. */
export const isCodexCapacityError = reason => /^Selected model is at capacity\./iu.test(String(reason || ""));

/** WHAT: Builds bounded continuation through the existing broker. WHY: Keeps restart persistence and queue identities from duplicating retries. */
export function createCodexCapacityRecovery({ state, broker, agent, now = () => Date.now(), readError = codexTurnError,
  readLatestPrompt = file => codexLastPrompt(parseJsonlText(readTailWindow(file, 256 * 1024).text)), log = console.warn } = {}) {
  const inFlight = new Set();
  const save = (key, value) => state.set(CAPACITY_STATE_KEY, { ...state.get(CAPACITY_STATE_KEY, {}), [key]: value });
  const get = key => state.get(CAPACITY_STATE_KEY, {})[key];

  function stillWaiting(name, pane, result, episode) {
    const jobs = broker.queue.list(name, pane);
    const owned = job => job.source === SOURCE && job.metadata?.capacityEpisode === episode.id;
    const newerInput = Date.parse(result.lastPrompt?.timestamp || "") > episode.at;
    const ownInput = newerInput && jobs.some(job => owned(job) && (job.verifyText || job.text) === result.lastPrompt.text);
    if ((newerInput && !ownInput) || jobs.some(job => !owned(job) && job.createdAt > episode.at)) return "superseded";
    if (jobs.some(job => owned(job) && job.status === "delivered_unverified")) return "unverified-delivery";
    if (jobs.some(job => !TERMINAL_DELIVERY_STATES.has(job.status))) return "delivery-in-progress";
    const lastJob = jobs.filter(owned).at(-1);
    // A receipt confirms input, not a failed model request. Wait for the new
    // capacity end before advancing to a second continuation.
    if (lastJob && Date.parse(result.refusals?.at(-1)?.timestamp || "") <= Number(lastJob.submittedAt || lastJob.createdAt)) return "awaiting-outcome";
    return null;
  }

  async function tickLocked({ name, pane, result }) {
    const key = `${name}:${pane}`;
    const refusal = result?.refusals?.at(-1);
    if (!refusal) return;
    const profile = selectedCodexProfile(state, name, pane);
    const session = codexThreadOfRollout(result.jsonlFile);
    const model = JSON.stringify(codexModelOverride(state, name, pane));
    let episode = get(key);
    if (episode && (episode.session !== session || episode.profile !== profile.id || episode.model !== model)) {
      save(key, { ...episode, done: true }); return;
    }
    const freshRefusal = episode && episode.lastRefusal !== refusal.id;
    const inputBeforeRefusal = Date.parse(result.lastPrompt?.timestamp || "") <= Date.parse(refusal.timestamp);
    const ownPrompt = broker.queue.list(name, pane).some(job => job.source === SOURCE
      && job.metadata?.capacityEpisode === episode?.id && (job.verifyText || job.text) === result.lastPrompt?.text);
    if (freshRefusal && inputBeforeRefusal && !ownPrompt) episode = null;
    if (episode && ["superseded", "unverified-delivery"].includes(stillWaiting(name, pane, result, episode))) {
      save(key, { ...episode, done: true });
      return;
    }
    if (!episode || episode.lastRefusal !== refusal.id) {
      const reason = Object.hasOwn(refusal, "reason") ? refusal.reason : await readError({ home: profile.home, threadId: session, refusal });
      if (!isCodexCapacityError(reason)) { if (episode) save(key, { ...episode, done: true }); return; }
      // Only our own continuation can extend an episode; it never resets the
      // three-attempt budget even if the provider refuses that prompt again.
      if (!episode || episode.done) {
        if (episode?.lastRefusal === refusal.id) return;
        episode = { id: refusal.id, at: Date.parse(refusal.timestamp), session, profile: profile.id, model, attempts: 0 };
      }
      episode = { ...episode, lastRefusal: refusal.id };
      save(key, episode);
    }
    if (episode.done || episode.attempts >= RETRY_AT_MS.length || !Number.isFinite(episode.at)) return;
    if (now() < episode.at + RETRY_AT_MS[episode.attempts]) return;
    const blocked = stillWaiting(name, pane, result, episode);
    if (blocked) { if (["superseded", "unverified-delivery"].includes(blocked)) save(key, { ...episode, done: true }); return; }
    const transport = await agent.promptTransportState(name, pane, CAPACITY_CONTINUE_TEXT);
    if (transport.dialect !== "codex" || transport.busy || transport.state !== "empty-idle") return;
    if (findBlockingPrompt(await agent.captureScreen(name, pane))) return;
    const latestPrompt = readLatestPrompt(result.jsonlFile);
    if (stillWaiting(name, pane, { ...result, lastPrompt: latestPrompt || result.lastPrompt }, episode)) return;
    if (JSON.stringify(codexModelOverride(state, name, pane)) !== model || selectedCodexProfile(state, name, pane).id !== profile.id) return;
    const attempt = episode.attempts + 1;
    const job = broker.enqueue({ agentName: name, pane, text: CAPACITY_CONTINUE_TEXT, source: SOURCE,
      idempotencyKey: `${SOURCE}:${session}:${episode.id}:${attempt}`,
      metadata: { capacityEpisode: episode.id, capacityRefusedAt: refusal.timestamp, capacitySessionFile: result.jsonlFile } });
    save(key, { ...episode, attempts: attempt, jobId: job.id });
    log(`${key} capacity continuation ${attempt}/3 queued (${job.id})`);
  }

  async function tick(input) {
    const key = `${input.name}:${input.pane}`;
    if (!broker || !input.result?.jsonlFile || inFlight.has(key)) return;
    inFlight.add(key);
    try { await broker.runExclusive(input.name, input.pane, () => tickLocked(input)); }
    catch (error) { log(`${key} capacity recovery failed: ${error.message}`); }
    finally { inFlight.delete(key); }
  }
  return { tick };
}
