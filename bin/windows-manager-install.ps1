# Thin installer and launcher for the Windows manager AI on the _windows_ channel.
# Installs the immutable manager core next to the restarter state, then opens a
# visible terminal running the manager. The visible terminal is the canonical
# operator path; -Hidden opts into a hidden launch for the scheduled-task path,
# and schtasks stays hidden by OS nature. Secrets never pass through this
# script: the manager config stores environment variable NAMES only.
[CmdletBinding(DefaultParameterSetName = "Install")]
param(
  [Parameter(ParameterSetName = "Install", Mandatory = $true)]
  [switch]$Install,
  [Parameter(ParameterSetName = "Install", Mandatory = $true)]
  [string]$ChannelId,
  [Parameter(ParameterSetName = "Install", Mandatory = $true)]
  [string]$AuthorizedUserId,
  [Parameter(ParameterSetName = "Install")]
  [string]$PythonPath = "E:\_Sdk\python\python.exe",
  [Parameter(ParameterSetName = "Install")]
  [string]$WhisperModelPath = "",
  [Parameter(ParameterSetName = "Install")]
  [string]$DiscordTokenEnv = "DISCORD_TOKEN",
  [Parameter(ParameterSetName = "Install")]
  [int]$PollSeconds = 5,
  [Parameter(ParameterSetName = "Install")]
  [switch]$Hidden,
  [Parameter(ParameterSetName = "RunManager", Mandatory = $true)]
  [switch]$RunManager,
  [Parameter(ParameterSetName = "Stop", Mandatory = $true)]
  [switch]$Stop
)

$ErrorActionPreference = "Stop"
$Root = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "AgentmuxRestarter"
$ManagerConfigPath = Join-Path $Root "manager.json"
$ManagerPidPath = Join-Path $Root "manager-process.json"
$ManagerCoreDir = Join-Path $Root "manager-core"
$InstalledInstaller = Join-Path $Root "manager-install.ps1"
$RuntimeIo = Join-Path $PSScriptRoot "windows-restarter-io.ps1"
if (!(Test-Path $RuntimeIo)) { throw "windows-restarter-io.ps1 is missing next to the manager installer" }
. $RuntimeIo

function Get-LiveManagerProcess {
  $record = Read-Json $ManagerPidPath
  if ($null -eq $record -or $null -eq $record.pid) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)" -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $null }
  if ([string]$process.CommandLine -notlike "*manager-core*") { return $null }
  return $process
}

function Get-AllManagerProcesses {
  $entry = (Join-Path $ManagerCoreDir "bin\windows-manager.mjs").ToLowerInvariant()
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -ieq "node.exe" -and [string]$_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($entry)
  })
}

function Stop-Manager {
  $processes = Get-AllManagerProcesses
  foreach ($process in $processes) { Stop-Process -Id $process.ProcessId -Force }
  Remove-Item -Force -ErrorAction SilentlyContinue $ManagerPidPath
  return $processes.Count -gt 0
}

if ($Install) {
  if ($ChannelId -notmatch "^\d{17,20}$" -or $AuthorizedUserId -notmatch "^\d{17,20}$") {
    throw "channel and authorized user must be Discord snowflake ids"
  }
  foreach ($envName in @($DiscordTokenEnv)) {
    if ($envName -notmatch "^[A-Za-z_][A-Za-z0-9_]*$") {
      throw "discordTokenEnv must be an environment variable name, never a secret"
    }
  }
  if ($PollSeconds -lt 2 -or $PollSeconds -gt 60) { throw "poll seconds must be 2..60" }
  $nodePath = ""
  $nodeCommand = Get-Command "node.exe" -ErrorAction SilentlyContinue
  if ($null -ne $nodeCommand) { $nodePath = $nodeCommand.Source }
  elseif (Test-Path "E:\_Sdk\nodejs\node.exe") { $nodePath = "E:\_Sdk\nodejs\node.exe" }
  if (!$nodePath) { throw "node.exe was not found" }
  $codexJs = Join-Path $env:APPDATA "npm\node_modules\@openai\codex\bin\codex.js"
  if (!(Test-Path $codexJs)) { throw "Windows-native Codex CLI was not found" }
  if (!(Test-Path $PythonPath)) { throw "Windows Python was not found" }
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  if (!$WhisperModelPath) { $WhisperModelPath = Join-Path $Root "models\faster-whisper-base" }
  foreach ($modelFile in @("model.bin", "config.json", "tokenizer.json", "vocabulary.txt")) {
    if (!(Test-Path (Join-Path $WhisperModelPath $modelFile))) { throw "offline Whisper model incomplete: $modelFile" }
  }
  Copy-Item -Force $MyInvocation.MyCommand.Path $InstalledInstaller
  Copy-Item -Force $RuntimeIo (Join-Path $Root "windows-restarter-io.ps1")
  $config = [pscustomobject]@{
    version = 1
    channelId = $ChannelId
    authorizedUserId = $AuthorizedUserId
    pollSeconds = $PollSeconds
    nodePath = $nodePath
    provider = [pscustomobject]@{
      kind = "cli"
      command = $nodePath
      args = @($codexJs, "exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "-")
      timeoutMs = 120000
    }
    transcription = [pscustomobject]@{
      kind = "faster-whisper"
      pythonPath = $PythonPath
      modelPath = $WhisperModelPath
      timeoutMs = 90000
    }
    discordTokenEnv = $DiscordTokenEnv
  }
  Write-JsonAtomic -Path $ManagerConfigPath -Value $config

  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $repoRoot = Split-Path -Parent $scriptDir
  $coreBinDir = Join-Path $ManagerCoreDir "bin"
  $coreModuleDir = Join-Path $ManagerCoreDir "core"
  New-Item -ItemType Directory -Force -Path $coreBinDir | Out-Null
  New-Item -ItemType Directory -Force -Path $coreModuleDir | Out-Null
  $sources = @(
    @{ from = (Join-Path $scriptDir "windows-manager.mjs"); name = "bin/windows-manager.mjs" },
    @{ from = (Join-Path $scriptDir "windows-transcribe.py"); name = "bin/windows-transcribe.py" },
    @{ from = (Join-Path $scriptDir "windows-recovery.mjs"); name = "bin/windows-recovery.mjs" },
    @{ from = (Join-Path $scriptDir "windows-rescue-tool.ps1"); name = "bin/windows-rescue-tool.ps1" },
    @{ from = (Join-Path $scriptDir "windows-restarter-io.ps1"); name = "bin/windows-restarter-io.ps1" },
    @{ from = (Join-Path $repoRoot "core\windows-manager.mjs"); name = "core/windows-manager.mjs" },
    @{ from = (Join-Path $repoRoot "core\windows-manager-discord.mjs"); name = "core/windows-manager-discord.mjs" },
    @{ from = (Join-Path $repoRoot "core\windows-manager-input.mjs"); name = "core/windows-manager-input.mjs" },
    @{ from = (Join-Path $repoRoot "core\windows-bridge.mjs"); name = "core/windows-bridge.mjs" },
    @{ from = (Join-Path $repoRoot "core\windows-recovery.mjs"); name = "core/windows-recovery.mjs" }
  )
  $hashes = [ordered]@{}
  foreach ($source in $sources) {
    if (!(Test-Path $source.from)) { throw "manager core sources not found next to the installer" }
    $target = Join-Path $ManagerCoreDir ($source.name -replace "/", "\")
    Copy-Item -Force $source.from $target
    $hashes[$source.name] = (Get-FileHash -Algorithm SHA256 $target).Hash.ToLowerInvariant()
  }
  $releaseManifest = Read-Json (Join-Path $repoRoot ".agentmux-release.json")
  if ($null -eq $releaseManifest -or [string]$releaseManifest.sourceSha -notmatch "^[0-9a-f]{40}$") {
    throw "immutable package release identity is missing"
  }
  $manifest = [pscustomobject]@{
    schemaVersion = 1
    contractVersion = 1
    sourceSha = $releaseManifest.sourceSha
    files = [pscustomobject]$hashes
  }
  Write-JsonAtomic -Path (Join-Path $ManagerCoreDir "manifest.json") -Value $manifest

  Stop-Manager | Out-Null
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$InstalledInstaller`"", "-RunManager"
  ) -WindowStyle $(if ($Hidden) { "Hidden" } else { "Normal" })
  Write-Output "INSTALLED channel=$ChannelId user=$AuthorizedUserId launch=$(if ($Hidden) { "hidden" } else { "visible" })"
  exit 0
}

if ($RunManager) {
  $config = Read-Json $ManagerConfigPath
  if ($null -eq $config) { throw "manager is not installed" }
  $entry = Join-Path $ManagerCoreDir "bin\windows-manager.mjs"
  if (!(Test-Path $entry)) { throw "manager core is missing" }
  $node = [string]$config.nodePath
  if (!$node -or !(Test-Path $node)) { $node = "node.exe" }
  $discordEnv = $(if ($config.discordTokenEnv) { [string]$config.discordTokenEnv } else { "DISCORD_TOKEN" })
  if (![Environment]::GetEnvironmentVariable($discordEnv)) {
    # Hydrate the token from the restarter's DPAPI credential store for this
    # process only; at rest it stays inside the encrypted clixml, never printed.
    $credPath = Join-Path $Root "discord-token.clixml"
    if (Test-Path $credPath) {
      $cred = Import-Clixml -Path $credPath
      [Environment]::SetEnvironmentVariable($discordEnv, $cred.GetNetworkCredential().Password, "Process")
    }
  }
  if (![Environment]::GetEnvironmentVariable($discordEnv)) {
    Write-Output "MANAGER_BLOCKED env-missing:$discordEnv"
    exit 1
  }
  $env:MANAGER_CONFIG = $ManagerConfigPath
  $mutex = [Threading.Mutex]::new($false, "Local\AgentmuxWindowsManagerV1")
  $acquired = $false
  try { $acquired = $mutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $acquired = $true }
  if (!$acquired) { Write-Output "ALREADY_RUNNING"; exit 0 }
  try {
    & $node $entry
    exit $LASTEXITCODE
  } finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
  }
}

if ($Stop) {
  $stopped = Stop-Manager
  Write-Output $(if ($stopped) { "STOPPED" } else { "ALREADY_STOPPED" })
  exit 0
}
