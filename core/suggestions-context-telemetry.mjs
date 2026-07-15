// Canonical, replay-safe context telemetry reconciliation for Suggestions.
//
// Context is intentionally separate from subscription quota: it is a
// per-session measurement with a short cadence and explicit compaction
// generations. The caller supplies readings from `amux top --json`, which in
// turn uses core/context.mjs. This module never re-parses engine logs.

const STATE_VERSION = 1;
const DEFAULT_HEARTBEAT_MS = 5 * 60 * 1000;
const CONFIDENCE = new Set(["exact", "reported", "estimated"]);

const isoMs = (value) => {
  const ms = typeof value === "number" ? value : Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
};

const iso = (value) => {
  const ms = isoMs(value);
  return ms == null ? null : new Date(ms).toISOString();
};

const boundedText = (value, max) => {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
};

const finiteInteger = (value, min, max) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
};

export function emptyContextPushState() {
  return { version: STATE_VERSION, eventCursor: 0, agents: {}, pending: null };
}

export function normalizeContextPushState(value) {
  if (!value || value.version !== STATE_VERSION || typeof value.agents !== "object") {
    return emptyContextPushState();
  }
  return {
    version: STATE_VERSION,
    eventCursor: finiteInteger(value.eventCursor, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    agents: { ...value.agents },
    pending: value.pending && typeof value.pending === "object" ? value.pending : null,
  };
}

/** Parse fleet-progress's canonical session -> Suggestions project mapping. */
export function parseFleetProjects(raw) {
  const projects = {};
  for (const sourceLine of String(raw || "").split(/\r?\n/u)) {
    const line = sourceLine.replace(/\s+#.*$/u, "").trim();
    if (!line || line.startsWith("#")) continue;
    const [session, , , project] = line.split(/\s+/u);
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(session || "")) continue;
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(project || "")) continue;
    projects[session] = project;
  }
  return projects;
}

function normalizeReading(row, projectId, nowMs) {
  const agentId = boundedText(row?.agentId, 96);
  const engine = ["claude", "codex"].includes(row?.engine) ? row.engine : null;
  const percent = finiteInteger(Math.round(Number(row?.percent)), 0, 100);
  if (!agentId || !engine || percent == null) return null;
  const observedAt = iso(row?.observedAt) || new Date(nowMs).toISOString();
  return {
    projectId,
    agentId,
    engine,
    model: boundedText(row?.model, 120),
    effort: boundedText(row?.effort, 48),
    percent,
    usedTokens: finiteInteger(row?.usedTokens, 0, 10_000_000) ?? null,
    windowTokens: finiteInteger(row?.windowTokens, 1, 10_000_000) ?? null,
    observedAt,
    source: boundedText(row?.source, 80) || `${engine}-unknown`,
    confidence: CONFIDENCE.has(row?.confidence) ? row.confidence : "estimated",
  };
}

function semanticReading(reading) {
  return JSON.stringify({
    engine: reading.engine,
    model: reading.model,
    effort: reading.effort,
    percent: reading.percent,
    usedTokens: reading.usedTokens,
    windowTokens: reading.windowTokens,
    source: reading.source,
    confidence: reading.confidence,
  });
}

function publicSample(sample) {
  if (!sample) return null;
  const {
    projectId, agentId, engine, model, effort, percent, usedTokens,
    windowTokens, observedAt, reportedAt, source, confidence,
    sessionGeneration, sampleSeq,
  } = sample;
  return {
    projectId, agentId, engine, model, effort, percent, usedTokens,
    windowTokens, observedAt, reportedAt, source, confidence,
    sessionGeneration, sampleSeq,
  };
}

function compactCandidates(snapshot, explicitEvents) {
  const candidates = [];
  for (const event of explicitEvents || []) {
    const agentId = boundedText(event?.agentId, 96);
    const at = iso(event?.at);
    if (agentId && at) candidates.push({ agentId, at });
  }
  for (const row of snapshot?.agents || []) {
    const agentId = boundedText(row?.agentId, 96);
    const at = iso(row?.lastCompactAt);
    if (agentId && at) candidates.push({ agentId, at });
  }
  candidates.sort((left, right) => isoMs(left.at) - isoMs(right.at));
  return candidates;
}

/**
 * Reconcile one collection pass.
 *
 * A compact advances generation before readings are considered. A reading
 * observed at/before that compact is therefore discarded, permanently
 * preventing a delayed pre-compact sample from overwriting the reset.
 */
export function reconcileContextTelemetry({
  state: inputState,
  snapshot,
  compactEvents = [],
  projectBySession,
  mutationId,
  nowMs = Date.now(),
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  eventCursor,
}) {
  if (!mutationId) throw new Error("mutationId is required");
  const state = normalizeContextPushState(inputState);
  const next = {
    version: STATE_VERSION,
    eventCursor: finiteInteger(eventCursor, 0, Number.MAX_SAFE_INTEGER) ?? state.eventCursor,
    agents: structuredClone(state.agents),
    pending: null,
  };
  const rowsById = new Map((snapshot?.agents || []).map((row) => [row.agentId, row]));
  const compacts = [];

  for (const candidate of compactCandidates(snapshot, compactEvents)) {
    const row = rowsById.get(candidate.agentId);
    const session = row?.session || candidate.agentId.split(":")[0];
    const projectId = projectBySession?.[session];
    if (!projectId) continue;
    const previous = next.agents[candidate.agentId] || {
      generation: 1,
      sampleSeq: 0,
      lastCompactAt: null,
      lastSemantic: null,
      lastSample: null,
      lastReportedAt: null,
    };
    if (isoMs(candidate.at) <= (isoMs(previous.lastCompactAt) ?? -1)) continue;
    const generation = Math.max(1, Number(previous.generation) || 1) + 1;
    compacts.push({
      projectId,
      agentId: candidate.agentId,
      at: candidate.at,
      sessionGeneration: generation,
      before: publicSample(previous.lastSample),
    });
    next.agents[candidate.agentId] = {
      ...previous,
      generation,
      sampleSeq: 0,
      lastCompactAt: candidate.at,
      lastSemantic: null,
      lastSample: null,
      lastReportedAt: null,
    };
  }

  const samples = [];
  const nowIso = new Date(nowMs).toISOString();
  for (const row of snapshot?.agents || []) {
    const projectId = projectBySession?.[row?.session];
    if (!projectId) continue;
    const reading = normalizeReading(row, projectId, nowMs);
    if (!reading) continue;
    const previous = next.agents[reading.agentId] || {
      generation: 1,
      sampleSeq: 0,
      lastCompactAt: null,
      lastSemantic: null,
      lastSample: null,
      lastReportedAt: null,
    };
    if (isoMs(reading.observedAt) <= (isoMs(previous.lastCompactAt) ?? -1)) continue;
    const semantic = semanticReading(reading);
    const lastReportedMs = isoMs(previous.lastReportedAt) ?? -Infinity;
    const due = semantic !== previous.lastSemantic || nowMs - lastReportedMs >= heartbeatMs;
    if (!due) continue;
    const sampleSeq = (finiteInteger(previous.sampleSeq, 0, Number.MAX_SAFE_INTEGER) ?? 0) + 1;
    const sample = {
      ...reading,
      reportedAt: nowIso,
      sessionGeneration: Math.max(1, Number(previous.generation) || 1),
      sampleSeq,
    };
    samples.push(sample);
    next.agents[reading.agentId] = {
      ...previous,
      generation: sample.sessionGeneration,
      sampleSeq,
      lastSemantic: semantic,
      lastSample: sample,
      lastReportedAt: nowIso,
    };
  }

  const payload = samples.length || compacts.length ? {
    version: 1,
    mutationId,
    generatedAt: nowIso,
    samples,
    compacts,
  } : null;
  return { state: next, payload };
}
