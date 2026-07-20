import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { component, expect, feature, unit } from "bdd-vitest";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const readPowerShell = (name) => readFileSync(join(ROOT, "bin", name), "utf8");
const MAIN = readPowerShell("windows-discord-restarter.ps1");
const IO = readPowerShell("windows-restarter-io.ps1");
const DISCORD = readPowerShell("windows-restarter-discord.ps1");
const PS1 = `${MAIN}\n${IO}\n${DISCORD}`;

feature("windows restarter source contract", () => {
  unit("the shared core plans and journals before any command executes", {
    then: ["plan-message precedes the state write and the rescue call", () => {
      const planner = DISCORD.indexOf('-Command "plan-message"');
      const journal = DISCORD.indexOf("$State.Value.lastAction = $action");
      const rescue = DISCORD.indexOf("Invoke-WindowsCommand -Config $Config -Plan $plan");
      expect(planner).toBeGreaterThan(-1);
      expect(journal).toBeGreaterThan(-1);
      expect(journal).toBeGreaterThan(planner);
      expect(rescue).toBeGreaterThan(journal);
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

  unit("install preserves the bridge module layout with a sha256 manifest", {
    then: ["bin and core paths match the runtime import", () => {
      expect(PS1).toContain('Join-Path $Root "bridge-core"');
      expect(PS1).toContain('Join-Path $bridgeCoreDir "bin"');
      expect(PS1).toContain('Join-Path $bridgeCoreDir "core"');
      expect(PS1).toContain('"bin/windows-bridge.mjs"');
      expect(PS1).toContain('"core/windows-bridge.mjs"');
      expect(PS1).toContain("manifest.json");
      expect(PS1).toContain("Get-FileHash -Algorithm SHA256");
      expect(PS1).toContain("function Test-BridgeCore");
      expect(PS1).toContain("nodePath");
      expect(MAIN).toContain(". $RuntimeIo");
      expect(MAIN).toContain(". $RuntimeDiscord");
      expect(MAIN).toContain('Copy-Item -Force $RuntimeIo');
      expect(MAIN).toContain('Copy-Item -Force $RuntimeDiscord');
    }],
  });

  unit("Windows writes Node-readable JSON without a PowerShell 5.1 BOM", {
    then: ["the atomic writer explicitly selects BOM-free UTF-8", () => {
      const writerStart = IO.indexOf("function Write-JsonAtomic");
      const writerEnd = IO.indexOf("function Read-Json", writerStart);
      const writer = IO.slice(writerStart, writerEnd);
      expect(writer).toContain("System.Text.UTF8Encoding($false)");
      expect(writer).toContain("[System.IO.File]::WriteAllText");
      expect(writer).not.toContain("Set-Content -Encoding UTF8");
    }],
  });

  unit("a leftover started action is reconciled by core and permanently fenced", {
    then: ["the startup path advances the exact message cursor", () => {
      expect(PS1).toContain('status -eq "started"');
      expect(PS1).toContain('-Command "reconcile-state"');
      expect(PS1).toContain("$state.lastSeenId = [string]$state.lastAction.messageId");
      expect(PS1).toContain("$script:Generation = [guid]::NewGuid()");
    }],
  });

  component("the exact installed directory layout executes its self-check", {
    then: ["Node resolves core/windows-bridge.mjs and verifies both hashes", () => {
      const temporary = mkdtempSync(join(tmpdir(), "amux-windows-core-"));
      try {
        mkdirSync(join(temporary, "bin"), { recursive: true });
        mkdirSync(join(temporary, "core"), { recursive: true });
        copyFileSync(join(ROOT, "bin", "windows-bridge.mjs"), join(temporary, "bin", "windows-bridge.mjs"));
        copyFileSync(join(ROOT, "core", "windows-bridge.mjs"), join(temporary, "core", "windows-bridge.mjs"));
        const files = {};
        for (const name of ["bin/windows-bridge.mjs", "core/windows-bridge.mjs"]) {
          files[name] = createHash("sha256").update(readFileSync(join(temporary, name))).digest("hex");
        }
        const manifest = join(temporary, "manifest.json");
        writeFileSync(manifest, `\uFEFF${JSON.stringify({
          schemaVersion: 1,
          contractVersion: 1,
          sourceSha: "a".repeat(40),
          files,
        })}`);
        expect(execFileSync(process.execPath, [
          join(temporary, "bin", "windows-bridge.mjs"),
          "self-check",
          "--manifest", manifest,
          "--files-root", temporary,
        ], { encoding: "utf8" }).trim()).toBe("SELF_CHECK_OK");
        writeFileSync(join(temporary, "core", "windows-bridge.mjs"), "\n// tampered after install\n", { flag: "a" });
        expect(() => execFileSync(process.execPath, [
          join(temporary, "bin", "windows-bridge.mjs"),
          "self-check",
          "--manifest", manifest,
          "--files-root", temporary,
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))
          .toThrow(/SELF_CHECK_FAILED reason=hash-mismatch:core\/windows-bridge\.mjs/u);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }],
  });

  unit("no token or secret is ever echoed", {
    then: ["the token variable never reaches output or receipt paths", () => {
      const receiptLines = PS1.split("\n").filter((line) =>
        line.includes("Send-DiscordReceipt") || line.includes("Write-Output"));
      expect(receiptLines.every((line) => !line.includes("$token"))).toBe(true);
    }],
  });

  unit("a changed readiness inventory reports an exact blocker", {
    then: ["the Windows refusal preserves blocker kind, id, reason, and remaining count", () => {
      expect(IO).toContain("restart-ready-blocked:$($first.kind):$($first.id):$($first.reason):+$extra");
      expect(IO).toContain("@($blocked.blockers).Count");
    }],
  });

  unit("PowerShell stays split into thin files and visible foreground is canonical", {
    then: ["every file is below 500 lines and hidden launch is opt-in via -Hidden", () => {
      for (const source of [MAIN, IO, DISCORD]) {
        expect(source.trimEnd().split("\n").length).toBeLessThan(500);
      }
      expect(MAIN).toContain("persistence=hkcu-run-visible");
      expect(MAIN).toContain('-WindowStyle $(if ($Supervised -or $Hidden) { "Hidden" } else { "Normal" })');
      expect(MAIN).not.toMatch(/-WindowStyle\s+"Hidden"/u);
      expect(MAIN).toContain('[Parameter(ParameterSetName = "Run")]\n  [Parameter(ParameterSetName = "Start")]\n  [switch]$Hidden,');
      expect(MAIN).toContain("Start-Restarter -Hidden:$Hidden");
      expect(MAIN).toContain("if ($Hidden -and !$Supervised) { $arguments += \"-Hidden\" }");
      expect(MAIN).toContain("schtasks stays hidden by OS nature");
      expect(IO).toContain('exec "$AMUX_BIN" serve');
      expect(IO).not.toContain("serve --detach");
    }],
  });
});
