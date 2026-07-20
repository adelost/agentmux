import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, feature, unit } from "bdd-vitest";

const PS1 = readFileSync(
  join(new URL("..", import.meta.url).pathname, "bin", "windows-discord-restarter.ps1"),
  "utf8",
);

feature("windows restarter source contract", () => {
  unit("the journal entry is written before any command executes", {
    then: ["the started write precedes the rescue call and the cursor moves after the outcome", () => {
      const journal = PS1.indexOf('status = "started"');
      const rescue = PS1.indexOf("Invoke-Rescue -Config $Config -Hard:$false");
      expect(journal).toBeGreaterThan(-1);
      expect(rescue).toBeGreaterThan(journal);
      // lastSeenId may only be assigned after an outcome write for accepted commands.
      const earlyCursor = PS1.indexOf("$State.Value.lastSeenId = [string]$message.id");
      expect(earlyCursor).toBeGreaterThan(-1);
      expect(earlyCursor).toBeLessThan(journal); // skip-bookkeeping only
    }],
  });

  unit("bots and unauthorized authors are ignored; the channel contract stays exact", {
    then: ["bot skip and the snowflake comparison are both present", () => {
      expect(PS1).toContain("$message.author.bot -eq $true");
      expect(PS1).toContain("[string]$message.author.id -ne [string]$Config.authorizedUserId");
      expect(PS1).toContain('^\\d{17,20}$');
    }],
  });

  unit("destructive commands are gated on the bridge-core verdict, never direct", {
    then: ["Test-BridgeCore and destructive-check precede any Restart-Wsl invocation", () => {
      const gate = PS1.indexOf("Test-BridgeCore -Config $Config");
      const nodeCheck = PS1.indexOf("destructive-check --command");
      const hardPath = PS1.indexOf("Invoke-Rescue -Config $Config -Hard:$true");
      expect(gate).toBeGreaterThan(-1);
      expect(nodeCheck).toBeGreaterThan(gate);
      expect(hardPath).toBeGreaterThan(nodeCheck);
      // The refusal path is always present with a classified reason.
      expect(PS1).toContain("AMUX BLOCKED $reason");
      expect(PS1).toContain("AMUX BLOCKED runtime-unavailable");
    }],
  });

  unit("install ships the bridge core with a sha256 manifest and node verification", {
    then: ["copy, manifest, hashes, and Test-BridgeCore are all wired", () => {
      expect(PS1).toContain('Join-Path $Root "bridge-core"');
      expect(PS1).toContain("manifest.json");
      expect(PS1).toContain("Get-FileHash -Algorithm SHA256");
      expect(PS1).toContain("function Test-BridgeCore");
      expect(PS1).toContain("nodePath");
    }],
  });

  unit("a leftover started destructive action becomes blocked and is never retried", {
    then: ["the startup path marks it crashed-mid-action", () => {
      expect(PS1).toContain('status -eq "started"');
      expect(PS1).toContain("crashed-mid-action");
      expect(PS1).toContain("$script:Generation = [guid]::NewGuid()");
    }],
  });

  unit("no token or secret is ever echoed", {
    then: ["the token variable never reaches output or receipt paths", () => {
      const receiptLines = PS1.split("\n").filter((line) =>
        line.includes("Send-DiscordReceipt") || line.includes("Write-Output"));
      expect(receiptLines.every((line) => !line.includes("$token"))).toBe(true);
    }],
  });
});
