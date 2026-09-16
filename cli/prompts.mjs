// `amux prompts`: the fleet's blocking Yes/No dialogs, and a guarded way to
// answer one. The bridge watchdog acts on its own (docs/permission-watchdog.md);
// this command is what an orchestrator uses when it is handed a prompt, so it
// never has to scrape panes or send blind keys.
//
// Mattias 2026-09-15: "Annars så måste ni själva trigga den på något sätt eller
// lägga till så att det är möjligt att trigga den."

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { classifyPermissionPrompt, detectPermissionPrompt } from "../core/permission-watchdog.mjs";
import { gitKeepsFilesUnder, openPromptsPath, permissionDecisionLogPath } from "../channels/permission-watchdog.mjs";
import { listAgents } from "./config.mjs";

const ANSWER_SETTLE_MS = 1_500;

/** WHAT: Reads the watchdog's open-prompt snapshot. WHY: Keeps a prompt's real age visible outside the bridge. */
export function readOpenPromptAges(path = openPromptsPath()) {
  try {
    const snapshot = JSON.parse(readFileSync(path, "utf8"));
    return new Map(snapshot.prompts.map((p) => [p.pane, p]));
  } catch {
    return new Map();
  }
}

/** WHAT: Collects every pane that currently sits on a permission prompt. WHY: Keeps the owner from scraping tmux by hand. */
export async function collectOpenPrompts({ agent, agentsYamlPath, home = homedir(), holdsKeptFiles = gitKeepsFilesUnder }) {
  const rows = [];
  for (const a of listAgents(agentsYamlPath)) {
    if (a.backend === "native") continue;
    const panes = Array.isArray(a.panes) ? a.panes : [];
    for (let pane = 0; pane < panes.length; pane++) {
      let screen = "";
      try { screen = await agent.capturePane(a.name, pane, 120); } catch { continue; }
      const prompt = detectPermissionPrompt(screen);
      if (!prompt) continue;
      const decision = classifyPermissionPrompt(prompt, { home, holdsKeptFiles });
      rows.push({ paneKey: `${a.name}:${pane}`, agentName: a.name, pane, prompt, decision, orchestrator: a.orchestrator ?? null });
    }
  }
  return rows;
}

/** WHAT: Formats open prompts with the commands that end them. WHY: Keeps the answer one copyable line away. */
export function formatPromptRows(rows, { ages = new Map(), at = Date.now() } = {}) {
  if (!rows.length) return "No pane is waiting on a permission prompt.";
  return rows.map(({ paneKey, agentName, pane, prompt, decision, orchestrator }) => {
    const tracked = ages.get(paneKey);
    const waited = tracked ? `${Math.round((at - Date.parse(tracked.firstSeenAt)) / 60_000)} min` : "unknown (watchdog has not seen it yet)";
    const verdict = decision.action === "answer"
      ? `amux answers this one itself: ${decision.why}`
      : `needs a decision: ${decision.why}`;
    const owner = orchestrator === null ? "no orchestrator configured for this project" : `${agentName}:${orchestrator}`;
    return [
      `${paneKey}  waiting ${waited}`,
      `  ${prompt.reason}`,
      `  ${prompt.command.split("\n")[0].slice(0, 160)}`,
      `  ${verdict}`,
      `  owner: ${owner}${tracked?.orchestratorNotified ? " (already told)" : ""}`,
      `  yes: amux prompts answer ${agentName} -p ${pane} 1    no: amux prompts answer ${agentName} -p ${pane} 2    cancel: amux esc ${agentName} -p ${pane}`,
    ].join("\n");
  }).join("\n\n");
}

/**
 * WHAT: Dispatches one option to a prompt after re-reading the pane.
 * WHY: Keeps a closed dialog from turning the keystroke into a chat message.
 */
export async function answerPrompt({ agent, agentName, pane, choice, settleMs = ANSWER_SETTLE_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const wanted = Number(choice);
  if (!Number.isSafeInteger(wanted) || wanted < 1) throw new Error(`answer must be an option number (got '${choice}')`);
  const before = detectPermissionPrompt(await agent.capturePane(agentName, pane, 120));
  if (!before) throw new Error(`${agentName}:${pane} has no open permission prompt; nothing sent`);
  const offered = before.options.map((o) => Number(/(\d+)\./u.exec(o)?.[1]));
  if (!offered.includes(wanted)) throw new Error(`option ${wanted} is not offered in ${agentName}:${pane} (${before.options.join(" ")})`);
  await agent.typeLiteral(agentName, String(wanted), pane);
  await agent.sendEnter(agentName, pane);
  await sleep(settleMs);
  const after = detectPermissionPrompt(await agent.capturePane(agentName, pane, 120));
  return { cleared: !after || after.signature !== before.signature, reason: before.reason };
}

function usage() {
  return [
    "Usage:",
    "  amux prompts                                 list panes blocked by a permission prompt",
    "  amux prompts answer <agent> [-p N] <choice>  answer one, after re-reading the pane",
    `  decisions: ${permissionDecisionLogPath()}`,
  ].join("\n");
}

/** WHAT: Dispatches the prompts command. WHY: Keeps blocked panes visible and answerable from one place. */
export async function cmdPrompts(argv, ctx) {
  const [action, ...rest] = argv;
  if (!action) {
    const rows = await collectOpenPrompts({ agent: ctx.agent, agentsYamlPath: ctx.configPath });
    console.log(formatPromptRows(rows, { ages: readOpenPromptAges() }));
    return;
  }
  if (action !== "answer") throw new Error(`unknown prompts action '${action}'\n${usage()}`);
  const flagIdx = rest.indexOf("-p");
  const pane = flagIdx >= 0 ? Number(rest[flagIdx + 1]) : 0;
  const positional = rest.filter((arg, i) => i !== flagIdx && i !== flagIdx + 1);
  const [agentName, choice] = positional;
  if (!agentName || !choice) throw new Error(usage());
  const result = await answerPrompt({ agent: ctx.agent, agentName, pane, choice });
  console.log(result.cleared
    ? `Answered ${choice} in ${agentName}:${pane}; the dialog is gone (${result.reason}).`
    : `Sent ${choice} to ${agentName}:${pane}, but the same dialog is still on screen. Look at the pane.`);
}
