# Thin Windows/Discord/WSL I/O for windows-discord-restarter.ps1.

function Write-Log {
  param([string]$Message)
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -gt 2097152) {
    Move-Item -Force $LogPath "$LogPath.1"
  }
  Add-Content -Encoding UTF8 -Path $LogPath -Value (
    "{0:o} {1}" -f [DateTime]::UtcNow, ($Message -replace "[\r\n]+", " ")
  )
}

function Write-JsonAtomic {
  param([string]$Path, [object]$Value)
  $temporary = "$Path.$PID.tmp"
  $json = ($Value | ConvertTo-Json -Depth 8) + [Environment]::NewLine
  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($temporary, $json, $utf8WithoutBom)
  Move-Item -Force $temporary $Path
}

function Read-Json {
  param([string]$Path)
  if (!(Test-Path $Path)) { return $null }
  try { return Get-Content -Raw -Encoding UTF8 $Path | ConvertFrom-Json }
  catch { return $null }
}

function Assert-Identifier {
  param([string]$Value, [string]$Name)
  if ($Value -notmatch "^[A-Za-z0-9_.-]+$") {
    throw "$Name contains unsupported characters"
  }
}

function Get-Token {
  if (!(Test-Path $CredentialPath)) { throw "encrypted Discord credential is missing" }
  $credential = Import-Clixml -Path $CredentialPath
  if ($credential -isnot [System.Management.Automation.PSCredential]) {
    throw "encrypted Discord credential has the wrong shape"
  }
  return $credential.GetNetworkCredential().Password
}

function Invoke-Discord {
  param([string]$Method, [string]$Route, [object]$Body = $null)
  $parameters = @{
    Uri = "https://discord.com/api/v10$Route"
    Method = $Method
    Headers = @{
      Authorization = "Bot $(Get-Token)"
      "User-Agent" = "agentmux-windows-restarter/1"
    }
    TimeoutSec = 20
  }
  if ($null -ne $Body) {
    $parameters.ContentType = "application/json"
    $parameters.Body = $Body | ConvertTo-Json -Depth 8 -Compress
  }
  $response = Invoke-RestMethod @parameters
  if ($response -is [System.Array]) {
    $response | ForEach-Object { Write-Output $_ }
  } else {
    Write-Output $response
  }
}

function Send-DiscordReceipt {
  param([object]$Config, [string]$Message)
  try {
    Invoke-Discord -Method Post -Route "/channels/$($Config.channelId)/messages" -Body @{
      content = $Message
      allowed_mentions = @{ parse = @() }
    } | Out-Null
  } catch {
    Write-Log "receipt failed: $($_.Exception.Message)"
  }
}

function Invoke-ProcessBounded {
  param([string]$FilePath, [string]$Arguments, [int]$TimeoutSeconds)
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $FilePath
  $start.Arguments = $Arguments
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  if (!$process.Start()) { throw "failed to start $FilePath" }
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
    & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
    return [pscustomobject]@{
      ok = $false
      timedOut = $true
      exitCode = $null
      stdout = ""
      stderr = "process timed out after ${TimeoutSeconds}s"
    }
  }
  return [pscustomobject]@{
    ok = $process.ExitCode -eq 0
    timedOut = $false
    exitCode = $process.ExitCode
    stdout = $stdout.Result.Replace("`0", "").Trim()
    stderr = $stderr.Result.Replace("`0", "").Trim()
  }
}

function Invoke-WslScript {
  param([object]$Config, [string]$Script, [int]$TimeoutSeconds = 90)
  Assert-Identifier $Config.distro "distro"
  Assert-Identifier $Config.linuxUser "linux user"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
  $arguments = "-d $($Config.distro) -u $($Config.linuxUser) -- bash -lc `"echo $encoded | base64 -d | bash`""
  return Invoke-ProcessBounded -FilePath $WslExe -Arguments $arguments -TimeoutSeconds $TimeoutSeconds
}

function Get-AmuxScript {
  param([string]$Body)
  return @"
set -u
AMUX_BIN="`$(command -v amux 2>/dev/null || true)"
if [ -z "`$AMUX_BIN" ]; then
  AMUX_BIN="`$(find "`$HOME/.nvm/versions/node" -path '*/bin/amux' -type l 2>/dev/null | sort -V | tail -n 1)"
fi
[ -n "`$AMUX_BIN" ] || { echo 'AMUX_FAILED reason=amux-not-found'; exit 1; }
export PATH="`$(dirname "`$AMUX_BIN"):`$PATH"
ROOT="`$(dirname "`$(dirname "`$(readlink -f "`$AMUX_BIN")")")"
$Body
"@
}

function Test-BridgeCore {
  param([object]$Config)
  $script:BridgeCoreError = $null
  if (!(Test-Path $Config.nodePath)) {
    $script:BridgeCoreError = "node-missing:$($Config.nodePath)"
    return $false
  }
  $bridgeCoreDir = Join-Path $Root "bridge-core"
  $entry = Join-Path $bridgeCoreDir "bin\windows-bridge.mjs"
  $result = Invoke-ProcessBounded -FilePath $Config.nodePath -Arguments "`"$entry`" self-check --manifest `"$(Join-Path $bridgeCoreDir "manifest.json")`" --files-root `"$bridgeCoreDir`"" -TimeoutSeconds 30
  if (!$result.ok) {
    $script:BridgeCoreError = (($result.stdout, $result.stderr) -join " ").Trim()
    if (!$script:BridgeCoreError) { $script:BridgeCoreError = "self-check-failed" }
    return $false
  }
  return $true
}

function Invoke-BridgeNode {
  param([object]$Config, [string]$NodeArguments)
  $entry = Join-Path $Root "bridge-core\bin\windows-bridge.mjs"
  return Invoke-ProcessBounded -FilePath $Config.nodePath -Arguments "`"$entry`" $NodeArguments" -TimeoutSeconds 45
}

function Invoke-BridgeJson {
  param([object]$Config, [string]$Command, [object]$InputValue)
  $json = $InputValue | ConvertTo-Json -Depth 12 -Compress
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  $result = Invoke-BridgeNode -Config $Config -NodeArguments "$Command --input-base64 $encoded"
  if (!$result.ok) { throw "bridge-core $Command failed: $($result.stderr)" }
  try { return $result.stdout | ConvertFrom-Json }
  catch { throw "bridge-core $Command returned invalid JSON" }
}

function Get-BridgeRescueScript {
  return Get-AmuxScript 'AMUX_BIN="$AMUX_BIN" timeout 85s bash "$ROOT/bin/bridge-rescue.sh"'
}

function Get-BridgeStartScript {
  return Get-AmuxScript 'exec "$AMUX_BIN" serve'
}

function Get-WslProbeScript {
  return Get-AmuxScript @'
NODE_BIN="$(dirname "$AMUX_BIN")/node"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node 2>/dev/null || true)"
[ -n "$NODE_BIN" ] || { echo '{"error":"node-not-found"}'; exit 1; }
"$NODE_BIN" "$ROOT/bin/windows-wsl-probe.mjs"
'@
}

function Get-WslLogsScript {
  return @'
set -u
for file in "$HOME/.agentmux/bridge.log" "$HOME/.agentmux/serve-restart.log"; do
  if [ -r "$file" ]; then
    printf '\n== %s ==\n' "$(basename "$file")"
    tail -n 18 "$file"
  fi
done
'@
}

function Get-VerifiedRestartReceipt {
  param([object]$Config, [string]$ReceiptId)
  if ($ReceiptId -notmatch "^[0-9a-f]{32}$") {
    return [pscustomobject]@{ ok = $false; reason = "restart-ready-receipt-id"; path = $null; receipt = $null }
  }
  $script = Get-AmuxScript "`"`$AMUX_BIN`" restart-ready verify $ReceiptId --json"
  $result = Invoke-WslScript -Config $Config -Script $script -TimeoutSeconds 90
  if (!$result.ok) {
    $blocked = $null
    try { $blocked = $result.stdout | ConvertFrom-Json } catch {}
    if ($null -ne $blocked -and @($blocked.blockers).Count -gt 0) {
      $first = @($blocked.blockers)[0]
      $extra = @($blocked.blockers).Count - 1
      return [pscustomobject]@{
        ok = $false
        reason = "restart-ready-blocked:$($first.kind):$($first.id):$($first.reason):+$extra"
        path = $null
        receipt = $null
      }
    }
    return [pscustomobject]@{
      ok = $false
      reason = $(if ($result.timedOut) { "restart-ready-verify-timeout" } else { "restart-ready-verify-failed" })
      path = $null
      receipt = $null
    }
  }
  try { $verified = $result.stdout | ConvertFrom-Json }
  catch {
    return [pscustomobject]@{ ok = $false; reason = "restart-ready-verify-json"; path = $null; receipt = $null }
  }
  if ($verified.ready -ne $true -or $verified.verdict.allow -ne $true -or
      [string]$verified.receipt.receiptId -ne $ReceiptId) {
    $reason = $(if ($null -ne $verified.verdict) { [string]$verified.verdict.reason } else { "restart-ready-refused" })
    return [pscustomobject]@{ ok = $false; reason = $reason; path = $null; receipt = $null }
  }
  $directory = Join-Path $Root "restart-ready"
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $path = Join-Path $directory "$ReceiptId.json"
  Write-JsonAtomic -Path $path -Value $verified.receipt
  return [pscustomobject]@{ ok = $true; reason = "ok"; path = $path; receipt = $verified.receipt }
}

function Get-WslObservation {
  param([object]$Config, [int]$TimeoutSeconds = 35)
  $result = Invoke-WslScript -Config $Config -Script (Get-WslProbeScript) -TimeoutSeconds $TimeoutSeconds
  if ($result.ok) {
    try { return $result.stdout | ConvertFrom-Json }
    catch {
      return [pscustomobject]@{ schemaVersion = 1; wslReachable = $true; timedOut = $false; error = "probe-json-invalid" }
    }
  }
  return [pscustomobject]@{
    schemaVersion = 1
    wslReachable = $false
    timedOut = [bool]$result.timedOut
    error = (($result.stderr, $result.stdout) -join " ").Trim()
  }
}

function Get-StatusVerdict {
  param([object]$Config, [object]$Observation)
  return Invoke-BridgeJson -Config $Config -Command "classify-status" -InputValue $Observation
}

function Format-Status {
  param([object]$Config, [object]$Observation)
  $json = $Observation | ConvertTo-Json -Depth 12 -Compress
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  $result = Invoke-BridgeNode -Config $Config -NodeArguments "format-status --input-base64 $encoded"
  if (!$result.ok) { return "AMUX BLOCKED status-runtime-unavailable" }
  return $result.stdout.Trim()
}

function Start-WslBounded {
  param([object]$Config)
  $result = Invoke-WslScript -Config $Config -Script "printf 'WSL_START_OK\n'" -TimeoutSeconds 45
  return [pscustomobject]@{
    ok = $result.ok -and $result.stdout -match "WSL_START_OK"
    stage = "start-wsl"
    detail = (($result.stdout, $result.stderr) -join " ").Trim()
  }
}

function Write-BridgeForegroundLauncher {
  param([object]$Config)
  Assert-Identifier $Config.distro "distro"
  Assert-Identifier $Config.linuxUser "linux user"
  $payload = Join-Path $Root "start-wsl-bridge.sh"
  $launcher = Join-Path $Root "start-wsl-bridge.cmd"
  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  $script = (Get-BridgeStartScript).Replace("`r`n", "`n")
  [System.IO.File]::WriteAllText($payload, "$script`n", $utf8WithoutBom)
  @(
    "@echo off",
    "title Agentmux WSL Bridge",
    "`"$WslExe`" -d $($Config.distro) -u $($Config.linuxUser) -- bash < `"$payload`"",
    "echo.",
    "echo Bridge process exited. This window stays open for diagnosis.",
    "pause"
  ) | Set-Content -Encoding ASCII -Path $launcher
  return $launcher
}

function Start-BridgeForeground {
  param([object]$Config)
  $launcher = Write-BridgeForegroundLauncher -Config $Config
  Start-Process -FilePath "cmd.exe" -ArgumentList @("/k", "`"$launcher`"") -WindowStyle Normal
  $deadline = [DateTime]::UtcNow.AddSeconds(50)
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Seconds 1
    $observation = Get-WslObservation -Config $Config -TimeoutSeconds 10
    if ($observation.wslReachable -and $observation.bridge.state -eq "ok") {
      return [pscustomobject]@{ ok = $true; stage = "start-bridge"; detail = "heartbeat-ok" }
    }
    if ($observation.bridge.state -eq "hung" -or $observation.bridge.state -eq "stale-code") {
      return [pscustomobject]@{ ok = $false; stage = "start-bridge"; detail = "bridge-$($observation.bridge.state)" }
    }
  }
  return [pscustomobject]@{ ok = $false; stage = "start-bridge"; detail = "heartbeat-timeout" }
}

function Invoke-PostBootRevive {
  param([object]$Config)
  $script = Get-AmuxScript 'bash "$ROOT/bin/post-boot-revive.sh"'
  $result = Invoke-WslScript -Config $Config -Script $script -TimeoutSeconds 180
  return [pscustomobject]@{
    ok = $result.ok
    stage = "post-boot-revive"
    detail = (($result.stdout, $result.stderr) -join " ").Trim()
  }
}

function Invoke-Recovery {
  param([object]$Config)
  $stages = @()
  for ($step = 0; $step -lt 3; $step++) {
    $observation = Get-WslObservation -Config $Config
    $verdict = Get-StatusVerdict -Config $Config -Observation $observation
    if ($verdict.nextStep -eq "start-wsl") {
      $result = Start-WslBounded -Config $Config
      $stages += $result
      if (!$result.ok) {
        return [pscustomobject]@{ outcome = "BLOCKED"; reason = $result.detail; observation = $observation }
      }
      continue
    }
    if ($verdict.nextStep -eq "start-bridge") {
      $result = Start-BridgeForeground -Config $Config
      $stages += $result
      if (!$result.ok) {
        return [pscustomobject]@{ outcome = "BLOCKED"; reason = $result.detail; observation = $observation }
      }
      continue
    }
    return [pscustomobject]@{
      outcome = $(if ($verdict.outcome -eq "READY") { "RECOVERED" } else { [string]$verdict.outcome })
      reason = [string]$verdict.reason
      observation = $observation
      stages = $stages
    }
  }
  return [pscustomobject]@{
    outcome = "PARTIAL"
    reason = "recovery-step-limit"
    observation = Get-WslObservation -Config $Config
    stages = $stages
  }
}

function Get-BoundedLogs {
  param([object]$Config)
  $windows = $(if (Test-Path $LogPath) { (Get-Content -Tail 24 -Encoding UTF8 $LogPath) -join "`n" } else { "" })
  $wsl = Invoke-WslScript -Config $Config -Script (Get-WslLogsScript) -TimeoutSeconds 20
  $combined = "== windows ==`n$windows`n== wsl ==`n$(if ($wsl.ok) { $wsl.stdout } else { "unavailable: $($wsl.stderr)" })"
  $redacted = $combined `
    -replace "(?i)(authorization|token|secret|password)\s*[:=]\s*\S+", '$1=[REDACTED]' `
    -replace "[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}", "[REDACTED_DISCORD_TOKEN]" `
    -replace "(?i)\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b", "[REDACTED_API_TOKEN]" `
    -replace "(?i)\bBearer\s+[A-Za-z0-9._-]{16,}\b", "Bearer [REDACTED]"
  if ($redacted.Length -gt 1750) { return "…" + $redacted.Substring($redacted.Length - 1749) }
  return $redacted
}

function Restart-Wsl {
  param([object]$Config)
  $stop = Invoke-ProcessBounded -FilePath $WslExe -Arguments "--shutdown" -TimeoutSeconds 45
  if (!$stop.ok) {
    return [pscustomobject]@{ ok = $false; stage = "wsl-stop"; detail = $stop.stderr }
  }
  Start-Sleep -Seconds 4
  $start = Start-BridgeForeground -Config $Config
  if (!$start.ok) {
    return [pscustomobject]@{ ok = $false; stage = "wsl-start"; detail = $start.detail }
  }
  $revive = Invoke-PostBootRevive -Config $Config
  return [pscustomobject]@{
    ok = $revive.ok
    stage = $(if ($revive.ok) { "wsl-recovered" } else { "post-boot-revive" })
    detail = $revive.detail
  }
}

function Invoke-Rescue {
  param([object]$Config, [bool]$Hard)
  if ($Hard) { return Restart-Wsl -Config $Config }
  $soft = Invoke-WslScript -Config $Config -Script (Get-BridgeRescueScript) -TimeoutSeconds 100
  if ($soft.ok -and $soft.stdout -match "RESCUE_OK") {
    return [pscustomobject]@{ ok = $true; stage = "bridge"; detail = $soft.stdout }
  }
  $detail = (($soft.stdout, $soft.stderr) -join " ").Trim()
  Write-Log "soft rescue failed without escalation: $detail"
  return [pscustomobject]@{ ok = $false; stage = "bridge"; detail = $detail }
}
