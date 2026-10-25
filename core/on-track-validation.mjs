import { randomInt } from "node:crypto";
import { onTrackFresh, onTrackGit, onTrackRows, onTrackOwner, verifyOnTrackEvidence, verifyOnTrackLive } from "./on-track-evidence.mjs";
import { activeOnTrackRow, leaderQueueStop } from "./on-track-contract.mjs";

/** WHAT: Defines the fixed review checklist. WHY: Prevents agents from silently replacing the human's review with their own plan. */
export const ON_TRACK_CHECKS = Object.freeze({
  C1: "Every human ask in the last 24h maps to TASKS with the requested outcome, owner and estimate.",
  C2: "No requested outcome changed without a human instruction; compare TASKS diff with original asks.",
  C3: "No stalled row without a real stop; read TASKS and the owner's latest log. Time and supervision are not stops.",
  C4: "All configured main live paths have green evidence observed within 60 minutes; no new paid hourly run.",
  C5: "Previous deviations are resolved with evidence or have an owner and action.",
});
const stopKinds = new Set(["red", "unexpected-value", "money-cap", "new-cause", "human-decision"]);

/** WHAT: Checks source integrity, full coverage and one independent PASS sample. WHY: Keeps missing evidence and unknown answers visible as deviations. */
export function validateOnTrackReceipt({ project, cycle, receipt, at = cycle.at, commands = {}, sample = n => randomInt(n), recheck = null, sampling = true }) {
  const errors = [], deviations = [], context = { project, cycle, at, commands };
  const lists = ["checks", "deviations", "asks", "rows", "live", "outcomeChanges", "resolved"];
  if (!receipt || lists.some(key => !Array.isArray(receipt[key]) || receipt[key].length > 10000 || receipt[key].some(v => !v || typeof v !== "object" || Array.isArray(v)))) {
    return { valid: false, errors: ["receipt: invalid object/array shape"], deviations: [], sampled: null, at };
  }
  const verify = evidence => verifyOnTrackEvidence(evidence, context);
  const checks = Array.isArray(receipt?.checks) ? receipt.checks : [];
  const add = (id, text) => errors.push(`${id}: ${text}`);
  if (receipt?.project !== project.id || receipt?.cycle !== cycle.id || !onTrackFresh(receipt?.at, at)
    || Date.parse(receipt.at) < cycle.at) add("receipt", "wrong project/cycle or observation time");
  let rows = {};
  try { rows = onTrackRows(onTrackGit(project.root, ["show", `${cycle.tip}:${project.ledger}`])); }
  catch { add("TASKS", "unreadable ledger"); }
  if (!Object.keys(rows).length) add("TASKS", "no task rows parsed");
  for (const id of Object.keys(ON_TRACK_CHECKS)) {
    const matches = checks.filter(c => c.id === id), check = matches[0];
    if (matches.length !== 1 || !["PASS", "FAIL", "UNKNOWN"].includes(check?.result)) { add(id, "missing or duplicate answer"); continue; }
    if (!Array.isArray(check.evidence) || !check.evidence.length || !check.evidence.every(verify)) add(id, "missing or unverified evidence");
    if (check.result !== "PASS") {
      const owned = receipt.deviations?.filter(d => d.check === id && d.row && d.owner && d.action) || [];
      if (!owned.length) add(id, "FAIL/UNKNOWN needs an owned deviation");
      deviations.push(...owned);
    }
  }
  const isPass = id => checks.find(c => c.id === id)?.result === "PASS";
  const owned = (check, row) => receipt.deviations.some(d => d.check === check && d.row === row && d.owner && d.action);
  for (const d of receipt.deviations) {
    if (!Object.hasOwn(ON_TRACK_CHECKS, d.check) || !d.row || !onTrackOwner(d.owner) || !d.action) add("deviation", "missing check/row/single owner/action");
    else if (!deviations.some(existing => existing.check === d.check && existing.row === d.row)) deviations.push(d);
  }
  const mappings = [...receipt.asks];
  for (const ask of cycle.asks || []) if (!mappings.some(m => m.askId === ask.id) && ask.matchedRows?.length === 1) {
    const row = rows[ask.matchedRows[0]];
    if (row) mappings.push({ askId: ask.id, disposition: "row", row: row.row, owner: row.ownerId || row.owner, estimate: row.estimate,
      outcome: row.outcome, automatic: true, evidence: { kind: "file", path: project.ledger, sha: cycle.tip, line: row.line, quote: row.quote, at: new Date(at).toISOString() } });
  }
  if (cycle.c1ScopeVersion >= 2 && isPass("C1") === false && checks.find(c => c.id === "C1")?.result === "UNKNOWN"
    && !cycle.c1SourceErrors?.length) add("C1", "UNKNOWN requires an unreadable original source; missing orders are FAIL");
  for (const ask of cycle.asks || []) {
    const mapping = mappings.find(m => m.askId === ask.id), row = rows[mapping?.row];
    if (cycle.c1ScopeVersion >= 2 && mapping?.disposition === "answered") {
      let captured = [];
      try { if (commands[mapping.evidence?.record]?.probe === "answers") captured = JSON.parse(commands[mapping.evidence.record].stdout).answers || []; } catch { /* The source error stays a failed link below. */ }
      const linked = ask.replies?.some(p => p.id === mapping.replyId) || [...(cycle.replyCatalog || []), ...captured].some(p => p.id === mapping.replyId
        && p.agent === ask.agent && p.pane === ask.pane && Date.parse(p.at) >= Date.parse(ask.ts));
      if (!mapping.reason || !linked || !verify(mapping.evidence)) add("C1", `answer link missing or unrelated: ${ask.id}`);
      continue;
    }
    if (cycle.c1ScopeVersion >= 2 && mapping?.disposition && !["row", "missing"].includes(mapping.disposition)) add("C1", `invalid disposition: ${ask.id}`);
    if (cycle.c1ScopeVersion !== 2 && mapping?.disposition && mapping.disposition === ask.disposition?.kind && mapping.bindingRef === ask.disposition.binding.ref && mapping.reason) continue;
    if (ask.originUncertain && (isPass("C1") || !owned("C1", ask.id))) add("C1", `source origin unknown: ${ask.id}`);
    if (mapping?.row === null && mapping.reason && !isPass("C1") && owned("C1", ask.id) && verify(mapping.evidence)) continue;
    if (row && isPass("C1") && (!row.ownerId || /^(unknown|okän[dt]|saknas|tbd|n\/a|[-—?])$/iu.test(row.estimate))) add("C1", `owner or estimate unknown/ambiguous: ${ask.id}`);
    if (!mapping || !row || ![row.owner, row.ownerId].includes(mapping.owner) || !row.owner || mapping.estimate !== row.estimate || !row.estimate
      || mapping.outcome !== row.outcome || !row.outcome || !verify(mapping.evidence)
      || mapping.evidence.path !== project.ledger || mapping.evidence.line !== row.line || mapping.evidence.sha !== cycle.tip) add("C1", `unmapped or incomplete ask ${ask.id}`);
  }
  if (new Set(mappings.map(m => m.askId)).size !== mappings.length || mappings.some(m => !cycle.asks.some(a => a.id === m.askId))) add("C1", "extra or duplicate ask mapping");
  for (const [id, old] of Object.entries(cycle.previous?.outcomes || {})) {
    if (rows[id]?.outcome === old) continue;
    const change = receipt.outcomeChanges?.find(c => c.row === id);
    const ask = (cycle.approvalAsks || cycle.asks).find(a => a.id === change?.askId && Date.parse(a.ts) > (cycle.previous.at || 0));
    if ((!ask || !verify(change?.evidence)) && (isPass("C2") || !owned("C2", id))) add("C2", `outcome changed or row removed without human source: ${id}`);
  }
  if (cycle.outcomeHistory) {
    if (cycle.c1ScopeVersion >= 2 && cycle.outcomeHistory.parserVersion !== 2 && isPass("C2")) add("C2", "historical parser version unqualified; report UNKNOWN and preserve original cycle");
    if (!cycle.outcomeHistory.base && isPass("C2")) add("C2", "24h baseline unavailable; report UNKNOWN");
    if (cycle.outcomeHistory.errors?.length && (isPass("C2") || !owned("C2", "history"))) add("C2", "ambiguous historical TASKS source; report UNKNOWN with an owner for history");
    for (const actual of cycle.outcomeHistory.changes) {
      const change = receipt.outcomeChanges?.find(c => c.row === actual.row && c.commit === actual.sha);
      const ask = (cycle.approvalAsks || cycle.asks).find(a => a.id === change?.askId && Date.parse(a.ts) <= actual.at);
      if ((!ask || !verify(change?.evidence)) && (isPass("C2") || !owned("C2", actual.row))) add("C2", `unapproved historical outcome change ${actual.row}@${actual.sha}`);
    }
  }
  const tracked = receipt?.rows || [];
  for (const row of Object.values(rows).filter(activeOnTrackRow)) {
    const record = tracked.find(r => r.row === row.row);
    const queued = leaderQueueStop(record?.stop, { project, cycle, rows, row, verify });
    const stopped = queued || (stopKinds.has(record?.stop?.kind) && verify(record.stop.evidence));
    if (row.ownerId === "human" && record && verify(record.evidence)
      && record.stop?.kind === "human-decision" && verify(record.stop.evidence)) continue;
    if (!record || !verify(record.evidence) || !verify(record.ownerLog)) {
      if (isPass("C3") || !owned("C3", row.row)) add("C3", `missing task/latest-owner-log evidence: ${row.row}`);
      continue;
    }
    let latest = null, ownerRead = false;
    try {
      const log = JSON.parse(commands[record.ownerLog.record]?.stdout);
      if (log.owner === row.ownerId) { latest = log.latest; ownerRead = true; }
    } catch { /* Missing source is an explicit C3 validation error below. */ }
    if ((!ownerRead || (!latest && !stopped) || (record.progressAt && record.progressAt !== latest?.ts)) && (isPass("C3") || !owned("C3", row.row))) add("C3", `latest owner post not verified: ${row.row}`);
    if (record.waitingSince && (!Number.isFinite(Date.parse(record.waitingSince)) || Date.parse(record.waitingSince) > at)) add("C3", `invalid wait timestamp: ${row.row}`);
    if (record.waitingSince && !stopped) {
      if (isPass("C3")) add("C3", `unjustified wait: ${row.row}`);
      const deviation = deviations.find(d => d.check === "C3" && d.row === row.row);
      if (!deviation) add("C3", `unjustified wait needs an assigned deviation owner: ${row.row}`);
      else deviation.waitingSince = record.waitingSince;
    }
    if (!record.waitingSince && !stopped && !onTrackFresh(latest?.ts, at) && isPass("C3")) add("C3", `progress time unknown/stale: ${row.row}`);
  }
  for (const path of project.livePaths) {
    const proof = receipt?.live?.find(p => p.path === path);
    const green = proof?.result === "PASS" && verifyOnTrackLive(proof, context);
    if (!green && (isPass("C4") || !owned("C4", path))) add("C4", `missing, stale or red live path: ${path}`);
  }
  for (const old of cycle.previous?.deviations || []) {
    const next = receipt.deviations?.find(d => d.check === old.check && d.row === old.row && d.owner && d.action);
    const resolved = receipt.resolved?.find(d => d.check === old.check && d.row === old.row && verify(d.evidence));
    if (!next && !resolved) add("C5", `previous deviation lost: ${old.check}/${old.row}`);
  }
  const passes = checks.filter(c => c.result === "PASS");
  const chosen = sampling && passes.length ? passes[sample(passes.length)] : null;
  if (chosen) {
    const again = validateOnTrackReceipt({ project, cycle, receipt, at, commands, sampling: false });
    if (again.errors.some(error => error.startsWith(chosen.id + ":")) || !chosen.evidence.every(verify)
      || (recheck && !recheck(chosen, context))) add("sample", `${chosen.id} disagreed on independent read`);
  }
  return { valid: errors.length === 0, errors, deviations, sampled: chosen?.id || null,
    outcomes: Object.fromEntries(Object.values(rows).map(r => [r.row, r.outcome])), at, coveredUntil: cycle.at,
    sourceWindow: cycle.sourceWindow || { from: cycle.at - 86400000, until: cycle.at }, automaticMappings: mappings.filter(m => m.automatic), reviewed: checks.length,
    askLatencyMs: (cycle.asks || []).map(a => { const mapping = mappings.find(m => m.askId === a.id);
      const created = cycle.rowFirstSeen?.[mapping?.row];
      const bound = cycle.bindings?.find(b => [a.id, ...(a.observationIds || [])].includes(b.ledgerId) && b.kind === "row" && b.ref.endsWith(`:${mapping?.row}`));
      return { askId: a.id, observationIds: a.observationIds || [a.id], ms: Number.isFinite(created) ? Math.max(0, created - Date.parse(a.ts)) : null,
        bindingLatencyMs: bound ? Math.max(0, Date.parse(bound.ts) - Date.parse(a.ts)) : null }; }) };
}
