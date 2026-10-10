// Mattias 2026-10-10: "vi borde väl förbjuda det helt, det är bättre. Alltså fine att man har en subagent som har
// tomt kontext eller bara vet vad den ska göra". A fork copies the whole session into every call of the
// subagent: api:0's nine forks that day re-read 195k-443k of copied context per call.

/** WHAT: Recognises an Agent call that would fork the session. WHY: Keeps a copy of a session from starting. */
export const isForkRequest = (payload) => ["Agent", "Task"].includes(payload?.tool_name)
  && String(payload?.tool_input?.subagent_type ?? "").trim().toLowerCase() === "fork";

/** WHAT: Names the refusal and the allowed alternative. WHY: Keeps the agent from retrying the same fork. */
export const FORK_REFUSAL = 'Forks are banned in this fleet (Mattias 2026-10-10: "vi borde väl förbjuda det helt"): '
  + "a fork copies this whole session into every call of the subagent. Start a fresh subagent instead, "
  + 'for example subagent_type "general-purpose", with a short written brief of exactly what it needs.';
