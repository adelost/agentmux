import { confirmedCodexRefusals } from "./codex-refusal-notice.mjs";

/** WHAT: Reads unresolved provider errors without rereading their rollout. WHY: Prevents a later SQLite flush from being hidden by the journal cache. */
export async function refreshCodexRefusals(result, home) {
  if (!result) return;
  const candidates = result.refusalCandidates ?? result.refusals ?? [];
  const known = new Map((result.refusals || []).filter(event => event.reason).map(event => [event.id, event]));
  const pending = candidates.filter(event => !known.has(event.id));
  for (const event of await confirmedCodexRefusals({ ...result, refusals: pending }, home)) known.set(event.id, event);
  result.refusalCandidates = candidates;
  result.refusals = candidates.flatMap(event => known.has(event.id) ? [known.get(event.id)] : []);
}
