# Thin rescue entry point for the Windows manager AI on the _windows_ channel.
# Dot-sources the shared restarter I/O, runs exactly one bounded rescue
# function, and prints the result as one JSON line: {"ok":..,"stage":..,"detail":..}
# Destructive restarts are not exposed here; the restarter poller owns those.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("start-wsl", "start-bridge", "recover")]
  [string]$Command,
  [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"
if ($TimeoutSeconds -lt 5 -or $TimeoutSeconds -gt 600) { throw "TimeoutSeconds must be 5..600" }
$Root = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "AgentmuxRestarter"
$ConfigPath = Join-Path $Root "config.json"
$LogPath = Join-Path $Root "manager.log"
$WslExe = Join-Path $env:SystemRoot "System32\wsl.exe"
$RuntimeIo = Join-Path $PSScriptRoot "windows-restarter-io.ps1"
if (!(Test-Path $RuntimeIo)) { throw "windows-restarter-io.ps1 is missing next to the rescue tool" }
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
  param([string]$IoPath, [string]$JobRoot, [string]$JobLogPath, [string]$JobWslExe, [string]$JobConfigPath, [string]$Name)
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
  $recovery = Invoke-Recovery -Config $config
  return [pscustomobject]@{
    ok = $recovery.outcome -eq "RECOVERED"
    stage = "recover:$($recovery.outcome.ToLowerInvariant())"
    detail = [string]$recovery.reason
  }
}

$result = $null
$job = Start-Job -ScriptBlock $invokeRescue -ArgumentList @($RuntimeIo, $Root, $LogPath, $WslExe, $ConfigPath, $Command)
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

Write-Result -Ok ([bool]$result.ok) -Stage ([string]$result.stage) -Detail ([string]$result.detail)
if ($result.ok) { exit 0 }
exit 1
