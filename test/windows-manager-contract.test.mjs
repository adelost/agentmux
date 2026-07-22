import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, feature, unit } from "bdd-vitest";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MGR = readFileSync(join(ROOT, "bin", "windows-manager.mjs"), "utf8");
const RESCUE = readFileSync(join(ROOT, "bin", "windows-rescue-tool.ps1"), "utf8");
const CORE = readFileSync(join(ROOT, "core", "windows-manager.mjs"), "utf8");
const DISCORD = readFileSync(join(ROOT, "core", "windows-manager-discord.mjs"), "utf8");
const TURN = MGR.slice(
  MGR.indexOf("export async function runManagerTurn"),
  MGR.indexOf("export async function pollManagerChannel"),
);
const MAIN = MGR.slice(MGR.indexOf("async function main"));

feature("windows manager source contract", () => {
  unit("bots, strangers, empty text, and restarter-owned commands are skipped", {
    then: ["all four skip conditions guard the accepted path", () => {
      expect(DISCORD).toContain("message.author?.bot === true");
      expect(DISCORD).toContain("String(message.author?.id) !== String(config.authorizedUserId)");
      expect(DISCORD).toContain("classifyManagerInput(message)");
    }],
  });

  unit("the journal is written before any tool executes", {
    then: ["planAcceptedAction, then saveState, then executeTool", () => {
      const action = TURN.indexOf("planAcceptedAction");
      const save = TURN.indexOf("deps.saveState(state)");
      const execute = TURN.indexOf("deps.executeTool");
      expect(action).toBeGreaterThan(-1);
      expect(save).toBeGreaterThan(action);
      expect(execute).toBeGreaterThan(save);
      expect(TURN).toContain('status = result.ok ? "completed" : "failed"');
    }],
  });

  unit("destructive restart is reachable only through authenticated local intent", {
    then: ["the model cannot request it and the rescue tool reuses the shared one-shot restart", () => {
      expect(MGR).not.toContain("--shutdown");
      expect(RESCUE).not.toContain("--shutdown");
      expect(CORE).toContain("MODEL_TOOL_NAMES");
      expect(CORE).toContain("explicitHumanRestart");
      expect(CORE).toContain('modelCallable: false');
      expect(RESCUE).toContain('if ($Name -eq "restart-wsl") { return Restart-Wsl -Config $config }');
      expect(RESCUE).not.toContain("Invoke-Rescue");
      expect(RESCUE).not.toContain("Invoke-FencedWslRestart");
    }],
  });

  unit("secrets only enter through environment variable names", {
    then: ["no literal keys or tokens, config is read-only, detail output is redacted", () => {
      expect(MGR).toContain("process.env[");
      expect(CORE).toContain("apiKeyEnv");
      expect(MGR).toContain("discordTokenEnv");
      expect(MGR).not.toMatch(/apiKey\s*:\s*"[^"]{6,}/u);
      expect(MGR).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{8,}/u);
      expect(CORE).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{8,}/u);
      expect(MGR).not.toContain("writeJsonAtomic(configPath");
      expect(CORE).toContain("apiKeyProvider()");
      expect(RESCUE).toContain("[REDACTED_DISCORD_TOKEN]");
      expect(RESCUE).toContain("[REDACTED_API_TOKEN]");
      expect(RESCUE).not.toContain("$token");
      expect(RESCUE).not.toContain("Get-Token");
    }],
  });

  unit("manager state and pid records stay separate from the restarter", {
    then: ["manager-state and manager-process only, never the restarter files", () => {
      expect(MGR).toContain('"manager-state.json"');
      expect(MGR).toContain('"manager-process.json"');
      expect(MGR).toContain('"manager.log"');
      expect(MGR).not.toContain('"state.json"');
      expect(MGR).not.toContain('"process.json"');
      expect(MGR.match(/restarter\.log/gu)).toHaveLength(1);
      expect(MGR).toContain('tailFile(join(rootDir, "restarter.log"), 24)');
    }],
  });

  unit("outcomes are exact and outbound Discord text is redacted and chunked", {
    then: ["RECOVERED/PARTIAL/BLOCKED, redactSecrets before send, 1900 chunks, no mentions", () => {
      const combined = `${CORE}\n${MGR}\n${RESCUE}`;
      expect(combined).toContain("RECOVERED");
      expect(combined).toContain("PARTIAL");
      expect(combined).toContain("BLOCKED");
      expect(DISCORD).toContain("redactSecrets(turn.answer)");
      expect(MGR).toContain("MAX_DISCORD_CHUNK = 1900");
      expect(MGR).toContain("allowed_mentions: { parse: [] }");
      expect(MGR).toContain("classifyManagerOutcome(toolResults)");
    }],
  });

  unit("a crashed leftover is fenced at startup before the poll loop runs", {
    then: ["reconcileManagerStartup marks blocked crashed-mid-action and precedes polling", () => {
      expect(MGR).toContain("crashed-mid-action");
      const reconcile = MAIN.indexOf("reconcileManagerStartup(state)");
      const poll = MAIN.indexOf("pollManagerChannel({");
      expect(reconcile).toBeGreaterThan(-1);
      expect(poll).toBeGreaterThan(reconcile);
      expect(MGR).toContain('action.status = "blocked"');
      expect(MGR).toContain("state.lastSeenId = String(action.messageId)");
    }],
  });

  unit("the rescue tool dot-sources the shared io and stays bounded and redacted", {
    then: ["io dot-sourced, five commands, JSON shape, job timeout, redaction", () => {
      expect(RESCUE).toContain("windows-restarter-io.ps1");
      expect(RESCUE).toContain(". $RuntimeIo");
      expect(RESCUE).toContain('ValidateSet("start-wsl", "start-bridge", "restart-wsl", "recover", "recover-verify")');
      expect(RESCUE).toContain("Start-WslBounded");
      expect(RESCUE).toContain("Start-BridgeForeground");
      expect(RESCUE).toContain("Invoke-Recovery");
      expect(RESCUE).toContain("ConvertTo-Json -Compress");
      expect(RESCUE).toContain("ok = $");
      expect(RESCUE).toContain("stage = $");
      expect(RESCUE).toContain("Wait-Job -Job $job -Timeout $TimeoutSeconds");
      expect(RESCUE).toContain("Stop-Job");
      expect(RESCUE).toContain("-replace");
      expect(RESCUE.trimEnd().split("\n").length).toBeLessThan(200);
    }],
  });

  unit("recover-verify runs the bounded chain and defers every decision to core", {
    then: ["boot id, release check, bridge, drain, selective revive, plan CLI, chain JSON", () => {
      expect(RESCUE).toContain("[string]$BeforeBootId");
      expect(RESCUE).toContain("^[0-9a-fA-F-]{8,64}$");
      expect(RESCUE).toContain("cat /proc/sys/kernel/random/boot_id");
      expect(RESCUE).toContain("verify-release-identity.mjs");
      expect(RESCUE).toContain("memory-guard.mjs");
      expect(RESCUE).toContain('"$AMUX_BIN" queue --json');
      expect(RESCUE).toContain('"$AMUX_BIN" revive --dry');
      expect(RESCUE).toContain("$RecoveryCli");
      expect(RESCUE).toContain("windows-recovery.mjs");
      expect(RESCUE).toContain('Invoke-RecoveryNode $node "plan" $measured');
      expect(RESCUE).toContain("classify-auth");
      expect(RESCUE).toContain("$result.json");
      expect(RESCUE).toContain("revive --dry");
      expect(RESCUE.indexOf("$dry = Invoke-WslScript")).toBeLessThan(RESCUE.indexOf("$revive = Invoke-WslScript"));
      expect(RESCUE).not.toContain("revive --all");
    }],
  });

  unit("the manager routes recover through the exact chain when a pre-boot id is stored", {
    then: ["planRescueCommand picks recover-verify, plain recover stays degraded PARTIAL", () => {
      expect(CORE).toContain("trackManagerBootId");
      expect(CORE).toContain("planRescueCommand");
      expect(MGR).toContain("planRescueCommand({ name, beforeBootId })");
      expect(MGR).toContain("mapRecoveryChainResults");
      expect(MGR).toContain("trackManagerBootId(state, observation)");
      expect(MGR).toContain("beforeBootId: state.prevBootId || null");
      expect(MGR).toContain("skipped:before-boot-unknown");
      expect(MGR).toContain('"-BeforeBootId", plan.beforeBootId');
    }],
  });

  unit("every manager file stays under its line cap", {
    then: ["core and bin under 500, the loop under 300", () => {
      expect(CORE.trimEnd().split("\n").length).toBeLessThan(500);
      expect(MGR.trimEnd().split("\n").length).toBeLessThan(300);
      expect(DISCORD.trimEnd().split("\n").length).toBeLessThan(300);
      expect(RESCUE.trimEnd().split("\n").length).toBeLessThan(500);
    }],
  });
});
