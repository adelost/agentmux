/** WHAT: Reads one exact existing native session. WHY: Prevents status and receipt checks from provisioning agents or resetting their settings. */
export async function readNativeHistory(spec, api, RuntimeError) {
  const fail = code => new RuntimeError(code, { code });
  const addressMatches = agent => agent.address?.session === spec.name && Number(agent.address.pane) === spec.pane;
  const adoptedId = String(spec.paneConfig.nativeAgentId || "").trim();
  const listing = await api(spec.runtimeUrl, "/api/projects");
  const matches = (Array.isArray(listing?.projects) ? listing.projects : []).flatMap(project =>
    (Array.isArray(project.agents) ? project.agents : [])
      .filter(agent => adoptedId ? agent.id === adoptedId : addressMatches(agent))
      .map(agent => ({ project, agent })));
  if (matches.length !== 1) throw fail("native-observation-target-mismatch");
  const { project, agent } = matches[0];
  if (!agent.id || agent.projectId !== project.id || project.cwd !== spec.entry.dir || agent.engine !== spec.engine
      || (adoptedId && !agent.sessionId) || (agent.address && !addressMatches(agent))) {
    throw fail("native-observation-target-mismatch");
  }
  const snapshot = await api(spec.runtimeUrl, `/api/agents/${encodeURIComponent(agent.id)}/history`);
  const identity = value => JSON.stringify([value?.id, value?.projectId, value?.engine, value?.cwd,
    value?.sessionId ?? null, value?.address?.session ?? null, value?.address?.pane ?? null]);
  if (identity(snapshot?.agent) !== identity(agent) || !Array.isArray(snapshot?.events)) {
    throw fail("native-observation-session-changed");
  }
  return snapshot;
}

/** WHAT: Maps runtime context into the existing adapter view. WHY: Keeps observation separate from configured model defaults. */
export function contextShape(context) {
  if (!context || !Number.isFinite(context.percent)) return null;
  return {
    percent: Math.round(context.percent),
    tokens: Number.isFinite(context.usedTokens) ? context.usedTokens : null,
    model: context.model ?? null,
    effort: context.effort ?? null,
    source: "native-runtime",
  };
}

/** WHAT: Returns the current response text from runtime events. WHY: Keeps read-only response rendering independent of provisioning. */
export function responseSegments(events = []) {
  let current = [];
  let latest = [];
  for (const event of events) {
    if (event?.type === "web" && event.subtype === "user") current = [];
    if (event?.type === "assistant") {
      const text = (Array.isArray(event.message?.content) ? event.message.content : [])
        .filter((item) => typeof item?.text === "string"
          && ["text", "input_text", "output_text"].includes(item.type))
        .map((item) => item.text.trim())
        .filter(Boolean);
      current.push(...text);
    }
    if (event?.type === "web" && event.subtype === "turn-done") latest = [...current];
  }
  return current.length ? current : latest;
}
