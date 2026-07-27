// Windows Link connector: polls the public mailbox for target=windows and
// answers through the manager turn machinery. Journals per message in
// manager-state so a restart can never double-ack or double-reply.

const CONNECTOR_ID = "windows-1";

/** WHAT: Maps one claimed windows message against manager state. WHY: Prevents a restart from re-acking finished mailbox work. */
export function planWindowsLinkMessage({ message, stateEntry }) {
  if (stateEntry?.stage === "replied") return { action: "skip" };
  if (stateEntry?.stage === "delivered") return { action: "await-reply", message };
  return { action: "deliver", message };
}

/** WHAT: Dispatches one bounded poll cycle for target=windows. WHY: Keeps every windows mailbox message answered exactly once. */
export async function runWindowsLinkCycle({
  fetchImpl = fetch,
  linkBase,
  token,
  state,
  deps,
  history,
  serializeTurn,
  runManagerTurn,
  log = () => {},
} = {}) {
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = async (path, body) => {
    const response = await fetchImpl(`${linkBase}${path}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(30_000),
    });
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`link-${path.replaceAll("/", "-")}-${response.status}`);
    return parsed;
  };

  const claimed = await post("/api/link/connector/poll?source=windows");
  const messages = Array.isArray(claimed.messages) ? claimed.messages : [];
  state.linkMessages = state.linkMessages || {};
  let handled = 0;
  for (const message of messages) {
    const id = String(message.clientMessageId || "");
    const plan = planWindowsLinkMessage({ message, stateEntry: state.linkMessages[id] });
    if (plan.action === "skip") continue;
    try {
      if (plan.action === "deliver") {
        state.linkMessages[id] = { stage: "claimed", at: Date.now() };
        deps.saveState(state);
        await post("/api/link/connector/ack", { clientMessageId: id, connectorId: CONNECTOR_ID });
        state.linkMessages[id] = { stage: "delivered" };
        deps.saveState(state);
      }
      const turn = await serializeTurn(() => runManagerTurn({
        userText: String(message.body || "").slice(0, 4000),
        messageId: `link:${id}`,
        state,
        history,
        deps,
      }));
      const answer = String(turn?.answer || "").trim();
      if (!answer) throw new Error("manager-answer-empty");
      await post("/api/link/connector/reply", { clientMessageId: id, connectorId: CONNECTOR_ID, body: answer });
      state.linkMessages[id] = { stage: "replied", replyAt: Date.now() };
      deps.saveState(state);
      handled += 1;
    } catch (error) {
      log(`windows-link ${id} failed: ${String(error?.message || error)}`);
      await post("/api/link/connector/fail", { clientMessageId: id, connectorId: CONNECTOR_ID, error: "manager-turn-failed" }).catch(() => {});
      state.linkMessages[id] = { stage: "failed", error: String(error?.message || error).slice(0, 200) };
      deps.saveState(state);
    }
  }
  return { claimed: messages.length, handled };
}

/** WHAT: Schedules the windows Link poll loop when configured. WHY: Keeps the mailbox reachable while WSL is dead. */
export function startWindowsManagerLink({ state, deps, history, serializeTurn, runManagerTurn, log = () => {} } = {}) {
  const linkBase = process.env.LINK_BASE;
  const token = process.env.LINK_TOKEN_WINDOWS;
  if (!linkBase || !token) return false;
  const cycle = () => runWindowsLinkCycle({
    linkBase,
    token,
    state,
    deps,
    history,
    serializeTurn,
    runManagerTurn,
    log,
  }).catch((error) => log(`windows-link | cycle failed: ${error?.message || error}`));
  setTimeout(() => {
    void cycle();
    setInterval(cycle, 15_000);
  }, 20_000);
  log("windows-link | enabled | target=windows");
  return true;
}
