# Thin rescue entry point for the Windows manager AI on the _windows_ channel.
# Dot-sources the shared restarter I/O, runs exactly one bounded rescue
# function, and prints the result as one JSON line: {"ok":..,"stage":..,"detail":..}
# recover-verify prints the full chain JSON {"stages":..,"outcome":..,"report":..}
# built by bin/windows-recovery.mjs; its stage details are fixed strings and
# pane names, never raw command output. restart-wsl is reachable only through
# the manager's authenticated, deterministic local-command parser.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("start-wsl", "start-bridge", "restart-wsl", "recover", "recover-verify")]
  [string]$Command,
  [string]$BeforeBootId = "",
  [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"
if ($TimeoutSeconds -lt 5 -or $TimeoutSeconds -gt 600) { throw "TimeoutSeconds must be 5..600" }
if ($BeforeBootId -and $BeforeBootId -notmatch "^[0-9a-fA-F-]{8,64}$") { throw "BeforeBootId must be a boot id of hex and dashes" }
$Root = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "AgentmuxRestarter"
$ConfigPath = Join-Path $Root "config.json"
$LogPath = Join-Path $Root "manager.log"
$WslExe = Join-Path $env:SystemRoot "System32\wsl.exe"
$RuntimeIo = Join-Path $PSScriptRoot "windows-restarter-io.ps1"
$RecoveryCli = Join-Path $PSScriptRoot "windows-recovery.mjs"
if (!(Test-Path $RuntimeIo)) { throw "windows-restarter-io.ps1 is missing next to the rescue tool" }
if ($Command -eq "recover-verify" -and !(Test-Path $RecoveryCli)) { throw "windows-recovery.mjs is missing next to the rescue tool" }
. $RuntimeIo

function Protect-Detail {
  param([string]$Text)
  $redacted = [string]$Text `
    -replace "(?i)(authorization|token|secret|password)\s*[:=]\s*\S+", '$1=[REDACTED]' `
    -replace "[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}", "[REDACTED_DISCORD_TOKEN]" `
    -replace "(?i)\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b", "[REDACTED_API_TOKEN]" `
    -replace "(?i)\bBearer\s+[A-Za-z0-9._-]{16,}\b", "Bearer [REDACTED]"
  $redacted = ($redacted -replace "[\r\n]+", " ").Trim()
  if ($redacted.Length -gt 800) { return $redacted.Substring(0, 800) }
  return $redacted
}

function Write-Result {
  param([bool]$Ok, [string]$Stage, [string]$Detail)
  [pscustomobject]@{
    ok = $Ok
    stage = $Stage
    detail = Protect-Detail $Detail
  } | ConvertTo-Json -Compress
}

$invokeRescue = {
  param([string]$IoPath, [string]$JobRoot, [string]$JobLogPath, [string]$JobWslExe, [string]$JobConfigPath, [string]$Name, [string]$BeforeBootId, [string]$RecoveryCli)
  $Root = $JobRoot
  $LogPath = $JobLogPath
  $WslExe = $JobWslExe
  $CredentialPath = Join-Path $JobRoot "discord-token.clixml"
  . $IoPath
  $config = Read-Json $JobConfigPath
  if ($null -eq $config) {
    return [pscustomobject]@{ ok = $false; stage = $Name; detail = "restarter-config-missing" }
  }
  if ($Name -eq "start-wsl") { return Start-WslBounded -Config $config }
  if ($Name -eq "start-bridge") { return Start-BridgeForeground -Config $config }
  if ($Name -eq "restart-wsl") { return Restart-Wsl -Config $config }
  if ($Name -eq "recover") {
    $recovery = Invoke-Recovery -Config $config
    return [pscustomobject]@{
      ok = $recovery.outcome -eq "RECOVERED"
      stage = "recover:$($recovery.outcome.ToLowerInvariant())"
      detail = [string]$recovery.reason
    }
  }

  # recover-verify: gather bounded measurements, let bin/windows-recovery.mjs decide.
  function Invoke-RecoveryNode {
    param([string]$NodePath, [string]$Command, [object]$Value)
    $json = $Value | ConvertTo-Json -Depth 8 -Compress
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $run = Invoke-ProcessBounded -FilePath $NodePath -Arguments "`"$RecoveryCli`" $Command --input-base64 $encoded" -TimeoutSeconds 20
    if (!$run.ok) { throw "recovery-node-$Command-unavailable" }
    return $run.stdout
  }
  function Test-AuthRemote {
    param([string]$NodePath, [string]$Text)
    if (!$Text) { return $false }
    try { return ((Invoke-RecoveryNode $NodePath "classify-auth" $Text) | ConvertFrom-Json).authFailure -eq $true }
    catch { return $false }
  }
  function Test-StageOk {
    param([object]$Plan, [string]$Stage)
    return @($Plan.stages | Where-Object { $_.stage -eq $Stage -and $_.ok -eq $true }).Count -gt 0
  }
  $node = [string]$config.nodePath
  if (!$node -or !(Test-Path $node)) {
    return [pscustomobject]@{ ok = $false; stage = "recover-verify"; detail = "node-missing" }
  }
  $measured = [ordered]@{
    beforeBootId = $(if ($BeforeBootId) { $BeforeBootId } else { $null })
    afterBootId = $null
    bridgeSourceSha = $null
    installedSourceSha = $null
    memoryLevel = $null
    dryRevive = @()
    bridgeOk = $null
    pendingDeliveries = $null
    revived = $null
    authFailure = $null
  }
  $preamble = 'NODE_BIN="$(dirname "$AMUX_BIN")/node"; [ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node 2>/dev/null || true)"; [ -n "$NODE_BIN" ] || exit 1;'
  $queueScript = Get-AmuxScript '"$AMUX_BIN" queue --json'
  $dryScript = Get-AmuxScript '"$AMUX_BIN" revive --dry'
  $reviveScript = Get-AmuxScript '"$AMUX_BIN" revive'

  $boot = Invoke-WslScript -Config $config -Script "cat /proc/sys/kernel/random/boot_id" -TimeoutSeconds 20
  $bootId = $(if ($boot.ok) { (($boot.stdout -split "\s+")[0]).Trim() } else { "" })
  if ($bootId -match "^[0-9a-fA-F-]{32,40}$") { $measured.afterBootId = $bootId }
  elseif (Test-AuthRemote $node (($boot.stdout, $boot.stderr) -join " ")) { $measured.authFailure = "boot-identity" }
  $memory = Invoke-WslScript -Config $config -Script (Get-AmuxScript "$preamble `"`$NODE_BIN`" `"`$ROOT/bin/memory-guard.mjs`" poll") -TimeoutSeconds 20
  if ($memory.ok) { try { $measured.memoryLevel = [string]($memory.stdout | ConvertFrom-Json).level } catch {} }
  $verify = Invoke-WslScript -Config $config -Script (Get-AmuxScript "$preamble `"`$NODE_BIN`" `"`$ROOT/bin/verify-release-identity.mjs`"") -TimeoutSeconds 60
  try { $identity = $verify.stdout | ConvertFrom-Json } catch { $identity = $null }
  if ($null -ne $identity -and $identity.allowRevive -eq $true -and $identity.sourceSha) {
    $measured.installedSourceSha = [string]$identity.sourceSha
  } elseif (Test-AuthRemote $node (($verify.stdout, $verify.stderr) -join " ")) {
    $measured.authFailure = "release-identity"
  }
  $bridgeManifest = Read-Json (Join-Path $JobRoot "bridge-core\manifest.json")
  if ($null -ne $bridgeManifest -and $bridgeManifest.sourceSha) {
    $measured.bridgeSourceSha = [string]$bridgeManifest.sourceSha
  }

  $plan = (Invoke-RecoveryNode $node "plan" $measured) | ConvertFrom-Json
  if (Test-StageOk $plan "bridge") {
    $bridge = Start-BridgeForeground -Config $config
    $measured.bridgeOk = [bool]$bridge.ok
    if (!$bridge.ok -and (Test-AuthRemote $node ([string]$bridge.detail))) { $measured.authFailure = "bridge" }
    if ($bridge.ok) {
      for ($i = 0; $i -lt 6 -and $measured.pendingDeliveries -ne 0; $i++) {
        $queue = Invoke-WslScript -Config $config -Script $queueScript -TimeoutSeconds 20
        if ($queue.ok) {
          try { $parsed = $queue.stdout | ConvertFrom-Json; if ($null -ne $parsed.total) { $measured.pendingDeliveries = [int]$parsed.total } } catch {}
        } elseif (Test-AuthRemote $node (($queue.stdout, $queue.stderr) -join " ")) {
          $measured.authFailure = "drain"
          break
        }
        if ($measured.pendingDeliveries -ne 0) { Start-Sleep -Seconds 5 }
      }
      $dry = Invoke-WslScript -Config $config -Script $dryScript -TimeoutSeconds 90
      if ($dry.ok) {
        $measured.dryRevive = @([regex]::Matches([string]$dry.stdout, "(\S+:\d+)\s+avbruten") | ForEach-Object { $_.Groups[1].Value } | Select-Object -First 40)
      }
      $plan = (Invoke-RecoveryNode $node "plan" $measured) | ConvertFrom-Json
      if (Test-StageOk $plan "revive") {
        $revive = Invoke-WslScript -Config $config -Script $reviveScript -TimeoutSeconds 150
        if ($revive.ok) {
          $measured.revived = @([regex]::Matches([string]$revive.stdout, "(?m)^\s*skickad:\s+(\S+)") | ForEach-Object { $_.Groups[1].Value })
        } elseif (Test-AuthRemote $node (($revive.stdout, $revive.stderr) -join " ")) {
          $measured.authFailure = "revive"
        }
      }
    }
  }
  $final = (Invoke-RecoveryNode $node "plan" $measured) | ConvertFrom-Json
  return [pscustomobject]@{
    ok = ($final.outcome -eq "RECOVERED")
    stage = "recover-verify:$($final.outcome.ToLowerInvariant())"
    json = ($final | ConvertTo-Json -Depth 8 -Compress)
    detail = [string]$final.report
  }
}

$result = $null
$job = Start-Job -ScriptBlock $invokeRescue -ArgumentList @($RuntimeIo, $Root, $LogPath, $WslExe, $ConfigPath, $Command, $BeforeBootId, $RecoveryCli)
try {
  if (Wait-Job -Job $job -Timeout $TimeoutSeconds) {
    $result = @(Receive-Job -Job $job) | Select-Object -Last 1
    if ($job.State -eq "Failed" -or $null -eq $result) {
      $reason = $job.ChildJobs[0].JobStateInfo.Reason
      $detail = $(if ($null -ne $reason) { [string]$reason.Message } else { "rescue-job-failed" })
      $result = [pscustomobject]@{ ok = $false; stage = $Command; detail = $detail }
    }
  } else {
    $result = [pscustomobject]@{ ok = $false; stage = $Command; detail = "rescue-timeout-${TimeoutSeconds}s" }
  }
} catch {
  $result = [pscustomobject]@{ ok = $false; stage = $Command; detail = $_.Exception.Message }
} finally {
  Stop-Job -Job $job -ErrorAction SilentlyContinue
  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
}

if ($Command -eq "recover-verify" -and $null -ne $result -and $null -ne $result.json) {
  Write-Output $result.json
  if ($result.ok) { exit 0 }
  exit 1
}
Write-Result -Ok ([bool]$result.ok) -Stage ([string]$result.stage) -Detail ([string]$result.detail)
if ($result.ok) { exit 0 }
exit 1
