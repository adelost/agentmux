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

// Tools that change Windows or WSL run at most once per order; reads may repeat.
const OBSERVE_ONLY_TOOLS = new Set(["get_status", "get_logs"]);
// Tools that can give WSL a new boot, with the //command the human knows them by.
const BOOT_ORDER_COMMANDS = Object.freeze({ restart_wsl: "//restart-wsl", start_wsl: "//start-wsl", recover: "//recover" });
const BOOT_ORDER_WINDOW_MS = 30 * 60_000;
const ORDER_MEMORY = 20;

/** WHAT: Checks whether this order already ran a tool that changes the system. WHY: Prevents a redelivered message from restarting WSL a second time. */
export function hasRunOrder(state, { messageId, tool }) {
  if (OBSERVE_ONLY_TOOLS.has(tool)) return false;
  return (state?.managerOrders || []).some((order) => order.messageId === String(messageId) && order.tool === tool);
}

/** WHAT: Tracks a system-changing tool for its order before it runs. WHY: Keeps the once-only fence and the boot attribution in persisted state. */
export function rememberOrder(state, { messageId, tool, nowMs }) {
  if (OBSERVE_ONLY_TOOLS.has(tool)) return state;
  const orders = [...(state.managerOrders || []), { messageId: String(messageId), tool, bootId: state.lastBootId || null, atMs: nowMs }];
  state.managerOrders = orders.slice(-ORDER_MEMORY);
  return state;
}

/** WHAT: Formats the line for a WSL boot change, or null when nothing needs saying. WHY: Prevents an unordered WSL restart from passing unnoticed without echoing an already reported one. */
export function planBootNotice({ fromBootId, toBootId, orders = [], nowMs, observer }) {
  if (!fromBootId || !toBootId || fromBootId === toBootId) return null;
  const order = [...orders].reverse().find((entry) => BOOT_ORDER_COMMANDS[entry.tool]
    && entry.bootId === fromBootId && nowMs - entry.atMs <= BOOT_ORDER_WINDOW_MS);
  if (!order) return `WSL har startat om (inte via //restart-wsl): boot ${fromBootId} -> ${toBootId}.`;
  // A turn that sees its own order's new boot reports it in its answer; only the watcher speaks up later.
  return observer === "watch" ? `WSL är uppe igen efter ${BOOT_ORDER_COMMANDS[order.tool]}: boot ${fromBootId} -> ${toBootId}.` : null;
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
