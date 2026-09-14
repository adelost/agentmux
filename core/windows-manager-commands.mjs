// Deterministic //commands and restart reporting for the Windows manager. The
// manager is the only live listener on the rescue channel, so every //command
// from the authorized human is either executed or answered; none is dropped.

import { COMMANDS, parseBridgeCommand } from "./windows-bridge.mjs";

const RESTART_WSL_TOOLS = Object.freeze(["get_status", "restart_wsl", "get_status"]);

const SLASH_PLANS = Object.freeze({
  status: { kind: "status", tools: ["get_status"] },
  logs: { kind: "logs", tools: ["get_logs"] },
  recover: { kind: "recovery", tools: ["get_status", "recover"] },
  "start-wsl": { kind: "start-wsl", tools: ["get_status", "start_wsl"] },
  "start-bridge": { kind: "start-bridge", tools: ["get_status", "start_bridge"] },
  // Legacy bridge-only rescue: it never shut WSL down, so it maps to the bridge start.
  restart: { kind: "start-bridge", tools: ["get_status", "start_bridge"] },
  "restart-wsl": { kind: "restart-wsl", tools: RESTART_WSL_TOOLS },
  hardrestart: { kind: "restart-wsl", tools: RESTART_WSL_TOOLS },
});

/** WHAT: Names the tool chain for an explicit WSL restart. WHY: Keeps the before and after observation that proves a reboot on both the //command and free-text paths. */
export function restartWslPlan() {
  return { kind: "restart-wsl", tools: [...RESTART_WSL_TOOLS] };
}

/** WHAT: Checks whether text is a //command. WHY: Keeps the deterministic vocabulary separate from free-text matching and the provider. */
export function isSlashCommand(text) {
  return String(text || "").trim().startsWith("//");
}

/** WHAT: Maps one //command to a local plan or an explicit refusal. WHY: Prevents an unknown or malformed //command from silently doing nothing. */
export function planSlashCommand(text) {
  const parsed = parseBridgeCommand(text);
  const plan = parsed ? SLASH_PLANS[parsed.command] : null;
  if (plan) return { kind: plan.kind, tools: [...plan.tools] };
  const shown = String(text || "").trim().split(/\s+/u)[0].slice(0, 40);
  return {
    kind: "unsupported",
    tools: [],
    answer: `AMUX BLOCKED okänt kommando ${shown}. Kommandon: ${COMMANDS.map((command) => `//${command}`).join(" ")}`,
  };
}

/** WHAT: Formats the notice sent before a destructive restart runs. WHY: Prevents minutes of silence between an accepted order and its result. */
export function formatRestartNotice(observation) {
  return `AMUX startar om WSL nu på ditt kommando. Före: wsl=${observation?.wsl || "unknown"} boot=${observation?.bootId || "unknown"}. Svar med ny boot kommer om 1-3 minuter.`;
}

/** WHAT: Formats one line saying whether WSL actually rebooted. WHY: Prevents a bare stage name from hiding whether the restart happened. */
export function describeRestartOutcome(toolResults) {
  const boots = (Array.isArray(toolResults) ? toolResults : [])
    .filter((result) => result?.observation)
    .map((result) => result.observation.bootId || null);
  const before = boots.length > 1 ? boots[0] : null;
  const after = boots.length > 1 ? boots.at(-1) : null;
  if (before && !after) return `WSL svarar inte efter omstarten: boot före ${before}, ingen boot efter.`;
  if (!before || !after) return "WSL-omstart okänd: ingen boot-id före och efter.";
  if (before === after) return `WSL startades INTE om: samma boot ${before}.`;
  return `WSL är omstartat: boot ${before} -> ${after}.`;
}

// What each rescue-tool stage means for the human, and what to type next.
const RESTART_STEP_HELP = Object.freeze({
  "wsl-recovered": { said: "WSL, bryggan och de avbrutna panelerna är uppe igen.", next: null },
  "wsl-stop": { said: "wsl --shutdown misslyckades", next: "skriv //status. Svarar WSL inte, starta om datorn." },
  "wsl-start": { said: "WSL stängdes men bryggan kom inte igång", next: "skriv //start-bridge, sedan //status." },
  "post-boot-revive": {
    said: "WSL och bryggan är uppe, men panelerna återupptogs inte",
    next: "panelerna startar när du skriver till dem. Följ fix-raden ovan och kör amux revive för att väcka de avbrutna.",
  },
  "restart-wsl": { said: "Omstarten gav inget svar i tid", next: "skriv //status och //logs." },
});

/** WHAT: Maps the restart tool result to plain lines and a next step. WHY: Prevents a stage code from being the only troubleshooting a human on a phone gets. */
export function explainRestartStep(result) {
  const help = RESTART_STEP_HELP[result?.stage];
  if (!help) return result && result.ok !== true ? [`Omstarten stoppade i steget ${result.stage}: ${String(result.detail || "")}`, "Nästa steg: skriv //logs."] : [];
  if (result.ok === true) return help.next ? [help.said, `Nästa steg: ${help.next}`] : [help.said];
  return [`${help.said}: ${String(result.detail || "okänd orsak")}`, `Nästa steg: ${help.next}`];
}
