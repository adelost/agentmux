import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, feature, unit } from "bdd-vitest";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTALLER = readFileSync(join(ROOT, "bin", "windows-manager-install.ps1"), "utf8");

feature("windows manager install source contract", () => {
  unit("channel and user are validated as Discord snowflakes", {
    then: ["the exact snowflake regex rejects every other shape", () => {
      expect(INSTALLER).toContain('^\\d{17,20}$');
      expect(INSTALLER).toContain("channel and authorized user must be Discord snowflake ids");
    }],
  });

  unit("secrets enter only as environment variable names", {
    then: ["env-name validation, no credential file, no stdin token read", () => {
      expect(INSTALLER).toContain("apiKeyEnv");
      expect(INSTALLER).toContain("discordTokenEnv");
      expect(INSTALLER).toContain("^[A-Za-z_][A-Za-z0-9_]*$");
      expect(INSTALLER).toContain("environment variable names, never secrets");
      expect(INSTALLER).not.toContain("Export-Clixml");
      expect(INSTALLER).not.toContain("Import-Clixml");
      expect(INSTALLER).not.toContain("ReadToEnd");
      expect(INSTALLER).not.toContain("discord-token.clixml");
      expect(INSTALLER).not.toContain("Get-Token");
    }],
  });

  unit("the manager core installs with bin/core layout and a sha256 manifest", {
    then: ["every runtime file is hashed and the release identity is required", () => {
      expect(INSTALLER).toContain('Join-Path $ManagerCoreDir "bin"');
      expect(INSTALLER).toContain('Join-Path $ManagerCoreDir "core"');
      expect(INSTALLER).toContain('"bin/windows-manager.mjs"');
      expect(INSTALLER).toContain('"bin/windows-recovery.mjs"');
      expect(INSTALLER).toContain('"core/windows-manager.mjs"');
      expect(INSTALLER).toContain('"core/windows-bridge.mjs"');
      expect(INSTALLER).toContain('"core/windows-recovery.mjs"');
      expect(INSTALLER).toContain("manifest.json");
      expect(INSTALLER).toContain("Get-FileHash -Algorithm SHA256");
      expect(INSTALLER).toContain(".agentmux-release.json");
      expect(INSTALLER).toContain("sourceSha");
      expect(INSTALLER).toContain("manager.json");
    }],
  });

  unit("the visible terminal is the default launch and hidden is opt-in", {
    then: ["no hardcoded hidden window style anywhere on the start path", () => {
      expect(INSTALLER).toContain("[switch]$Hidden");
      expect(INSTALLER).toContain('"-RunManager"');
      expect(INSTALLER).toContain('-WindowStyle $(if ($Hidden) { "Hidden" } else { "Normal" })');
      expect(INSTALLER).not.toMatch(/-WindowStyle\s+"Hidden"/u);
      expect(INSTALLER).toContain("schtasks stays hidden by OS nature");
      expect(INSTALLER).toContain("launch=$(if ($Hidden)");
    }],
  });

  unit("the manager process record is separate and -Stop is exact", {
    then: ["manager-process.json only, verified against the manager core path", () => {
      expect(INSTALLER).toContain("manager-process.json");
      expect(INSTALLER).toContain("Get-LiveManagerProcess");
      expect(INSTALLER).toContain("*manager-core*");
      expect(INSTALLER).toContain("Stop-Manager");
      expect(INSTALLER).toContain('"STOPPED"');
      expect(INSTALLER).toContain('"ALREADY_STOPPED"');
      expect(INSTALLER).not.toContain('"process.json"');
      expect(INSTALLER).not.toContain("restarter.ps1");
    }],
  });

  unit("no token or secret is ever echoed", {
    then: ["output lines never reference token variables or values", () => {
      const outputLines = INSTALLER.split("\n").filter((line) => line.includes("Write-Output"));
      expect(outputLines.length).toBeGreaterThan(0);
      expect(outputLines.every((line) => !line.includes("$token"))).toBe(true);
      expect(outputLines.every((line) => !line.includes("GetEnvironmentVariable"))).toBe(true);
      expect(INSTALLER).not.toContain("—");
      expect(INSTALLER.trimEnd().split("\n").length).toBeLessThan(500);
    }],
  });
});
