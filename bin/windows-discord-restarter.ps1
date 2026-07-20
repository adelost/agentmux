[CmdletBinding(DefaultParameterSetName = "Run")]
param(
  [Parameter(ParameterSetName = "Install", Mandatory = $true)]
  [switch]$Install,
  [Parameter(ParameterSetName = "Install", Mandatory = $true)]
  [string]$ChannelId,
  [Parameter(ParameterSetName = "Install", Mandatory = $true)]
  [string]$AuthorizedUserId,
  [Parameter(ParameterSetName = "Install")]
  [string]$Distro = "Ubuntu-22.04",
  [Parameter(ParameterSetName = "Install")]
  [string]$LinuxUser = "adelost",
  [Parameter(ParameterSetName = "Install")]
  [string]$NodePath = "",
  [Parameter(ParameterSetName = "Install")]
  [int]$PollSeconds = 3,
  [Parameter(ParameterSetName = "Run")]
  [switch]$Run,
  [Parameter(ParameterSetName = "Supervise")]
  [switch]$Supervise,
  [Parameter(ParameterSetName = "Start")]
  [switch]$Start,
  [Parameter(ParameterSetName = "StartSupervised")]
  [switch]$StartSupervised,
  [Parameter(ParameterSetName = "Stop")]
  [switch]$Stop,
  [Parameter(ParameterSetName = "Status")]
  [switch]$Status,
  [Parameter(ParameterSetName = "RescueTest")]
  [switch]$RescueTest
)

$ErrorActionPreference = "Stop"
$Root = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "AgentmuxRestarter"
$InstalledScript = Join-Path $Root "restarter.ps1"
$ConfigPath = Join-Path $Root "config.json"
$CredentialPath = Join-Path $Root "discord-token.clixml"
$StatePath = Join-Path $Root "state.json"
$PidPath = Join-Path $Root "process.json"
$SupervisorPidPath = Join-Path $Root "supervisor.json"
$DisabledPath = Join-Path $Root "disabled"
$LogPath = Join-Path $Root "restarter.log"
$TaskName = "AgentmuxDiscordRestarter"
$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$WslExe = Join-Path $env:SystemRoot "System32\wsl.exe"
$RuntimeIo = Join-Path $PSScriptRoot "windows-restarter-io.ps1"
$RuntimeDiscord = Join-Path $PSScriptRoot "windows-restarter-discord.ps1"
if (!(Test-Path $RuntimeIo) -or !(Test-Path $RuntimeDiscord)) {
  throw "Windows restarter runtime modules are missing"
}
. $RuntimeIo
. $RuntimeDiscord

function Get-LiveRestarterProcess {
  $record = Read-Json $PidPath
  if ($null -eq $record -or $null -eq $record.pid) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)" -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $null }
  if ([string]$process.CommandLine -notlike "*$InstalledScript*") { return $null }
  return $process
}

function Get-LiveSupervisorProcess {
  $record = Read-Json $SupervisorPidPath
  if ($null -eq $record -or $null -eq $record.pid) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)" -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $null }
  $commandLine = [string]$process.CommandLine
  if ($commandLine -notlike "*$InstalledScript*" -or $commandLine -notlike "*-Supervise*") {
    return $null
  }
  return $process
}

function Stop-Restarter {
  New-Item -ItemType File -Force -Path $DisabledPath | Out-Null
  $process = Get-LiveRestarterProcess
  $supervisor = Get-LiveSupervisorProcess
  $stopped = $false
  if ($null -ne $process) {
    Stop-Process -Id $process.ProcessId -Force
    $stopped = $true
  }
  if ($null -ne $supervisor) {
    Stop-Process -Id $supervisor.ProcessId -Force
    $stopped = $true
  }
  Remove-Item -Force -ErrorAction SilentlyContinue $PidPath
  Remove-Item -Force -ErrorAction SilentlyContinue $SupervisorPidPath
  return $stopped
}

function Start-Restarter {
  param([bool]$Supervised = $false)
  if ($null -ne (Get-LiveRestarterProcess)) { return }
  if (!(Test-Path $InstalledScript) -or !(Test-Path $ConfigPath) -or !(Test-Path $CredentialPath)) {
    throw "restarter is not installed"
  }
  Remove-Item -Force -ErrorAction SilentlyContinue $DisabledPath
  $mode = $(if ($Supervised) { "-Supervise" } else { "-Run" })
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$InstalledScript`"", $mode
  ) -WindowStyle $(if ($Supervised) { "Hidden" } else { "Normal" })
  for ($i = 0; $i -lt 100; $i++) {
    if ($null -ne (Get-LiveRestarterProcess)) { return }
    Start-Sleep -Milliseconds 100
  }
  throw "restarter did not start"
}

function Initialize-State {
  param([object]$Config)
  $messages = @(Invoke-Discord -Method Get -Route "/channels/$($Config.channelId)/messages?limit=1")
  $latest = $(if ($messages.Count -gt 0) { [string]$messages[0].id } else { "" })
  Write-JsonAtomic -Path $StatePath -Value ([pscustomobject]@{
    schemaVersion = 1
    lastSeenId = $latest
    lastPollAt = $null
    lastError = $null
    lastAction = $null
    generation = $null
  })
}

if ($Install) {
  if ($ChannelId -notmatch "^\d{17,20}$" -or $AuthorizedUserId -notmatch "^\d{17,20}$") {
    throw "channel and authorized user must be Discord snowflake ids"
  }
  Assert-Identifier $Distro "distro"
  Assert-Identifier $LinuxUser "linux user"
  if ($PollSeconds -lt 2 -or $PollSeconds -gt 30) { throw "poll seconds must be 2..30" }
  if (!$NodePath) {
    $nodeCommand = Get-Command "node.exe" -ErrorAction SilentlyContinue
    if ($null -ne $nodeCommand) { $NodePath = $nodeCommand.Source }
    elseif (Test-Path "E:\_Sdk\nodejs\node.exe") { $NodePath = "E:\_Sdk\nodejs\node.exe" }
  }
  $token = [Console]::In.ReadToEnd().Trim()
  if (!$token) { throw "Discord token was not provided on stdin" }
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  Copy-Item -Force $MyInvocation.MyCommand.Path $InstalledScript
  Copy-Item -Force $RuntimeIo (Join-Path $Root "windows-restarter-io.ps1")
  Copy-Item -Force $RuntimeDiscord (Join-Path $Root "windows-restarter-discord.ps1")
  $secure = ConvertTo-SecureString $token -AsPlainText -Force
  $credential = New-Object System.Management.Automation.PSCredential("discord-bot", $secure)
  $credential | Export-Clixml -Force -Path $CredentialPath
  Remove-Variable token
  $config = [pscustomobject]@{
    version = 1
    channelId = $ChannelId
    authorizedUserId = $AuthorizedUserId
    distro = $Distro
    linuxUser = $LinuxUser
    nodePath = $NodePath
    pollSeconds = $PollSeconds
  }
  Write-JsonAtomic -Path $ConfigPath -Value $config

  $bridgeCoreDir = Join-Path $Root "bridge-core"
  $bridgeBinDir = Join-Path $bridgeCoreDir "bin"
  $bridgeModuleDir = Join-Path $bridgeCoreDir "core"
  New-Item -ItemType Directory -Force -Path $bridgeBinDir | Out-Null
  New-Item -ItemType Directory -Force -Path $bridgeModuleDir | Out-Null
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $repoCore = Join-Path (Split-Path -Parent $scriptDir) "core\windows-bridge.mjs"
  $repoBin = Join-Path $scriptDir "windows-bridge.mjs"
  if (!(Test-Path $repoCore) -or !(Test-Path $repoBin)) {
    throw "bridge core sources not found next to the installer"
  }
  Copy-Item -Force $repoBin (Join-Path $bridgeBinDir "windows-bridge.mjs")
  Copy-Item -Force $repoCore (Join-Path $bridgeModuleDir "windows-bridge.mjs")
  $releaseManifest = Read-Json (Join-Path (Split-Path -Parent $scriptDir) ".agentmux-release.json")
  if ($null -eq $releaseManifest -or [string]$releaseManifest.sourceSha -notmatch "^[0-9a-f]{40}$") {
    throw "immutable package release identity is missing"
  }
  $manifest = [pscustomobject]@{
    schemaVersion = 1
    contractVersion = 1
    sourceSha = $releaseManifest.sourceSha
    files = [pscustomobject]@{
      "bin/windows-bridge.mjs" = (Get-FileHash -Algorithm SHA256 (Join-Path $bridgeBinDir "windows-bridge.mjs")).Hash.ToLowerInvariant()
      "core/windows-bridge.mjs" = (Get-FileHash -Algorithm SHA256 (Join-Path $bridgeModuleDir "windows-bridge.mjs")).Hash.ToLowerInvariant()
    }
  }
  Write-JsonAtomic -Path (Join-Path $bridgeCoreDir "manifest.json") -Value $manifest
  Initialize-State -Config $config
  Stop-Restarter | Out-Null
  Remove-Item -Force -ErrorAction SilentlyContinue $DisabledPath

  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
  $ErrorActionPreference = $previousErrorAction
  $runCommand = "powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File `"$InstalledScript`" -Run"
  New-Item -Force -Path $RunKey | Out-Null
  Set-ItemProperty -Path $RunKey -Name $TaskName -Value $runCommand
  Start-Restarter
  Write-Output "INSTALLED channel=$ChannelId user=$AuthorizedUserId persistence=hkcu-run-visible"
  exit 0
}

if ($Start) {
  Start-Restarter
  Write-Output "STARTED"
  exit 0
}

if ($StartSupervised) {
  Start-Restarter -Supervised:$true
  Write-Output "STARTED_SUPERVISED"
  exit 0
}

if ($Stop) {
  $stopped = Stop-Restarter
  Write-Output $(if ($stopped) { "STOPPED" } else { "ALREADY_STOPPED" })
  exit 0
}

if ($Status) {
  $process = Get-LiveRestarterProcess
  $supervisor = Get-LiveSupervisorProcess
  $state = Read-Json $StatePath
  [pscustomobject]@{
    installed = (Test-Path $InstalledScript) -and (Test-Path $CredentialPath)
    running = $null -ne $process
    supervised = $null -ne $supervisor
    pid = $(if ($null -ne $process) { $process.ProcessId } else { $null })
    supervisorPid = $(if ($null -ne $supervisor) { $supervisor.ProcessId } else { $null })
    channelId = (Read-Json $ConfigPath).channelId
    lastPollAt = $state.lastPollAt
    lastError = $state.lastError
    lastAction = $state.lastAction
  } | ConvertTo-Json -Depth 8
  exit 0
}

if ($RescueTest) {
  $config = Read-Json $ConfigPath
  if ($null -eq $config) { throw "restarter is not installed" }
  $result = Invoke-Rescue -Config $config -Hard:$false
  $result | ConvertTo-Json -Depth 4
  if (!$result.ok) { exit 1 }
  exit 0
}

if ($Supervise) {
  $created = $false
  $mutex = New-Object System.Threading.Mutex($true, "Local\AgentmuxDiscordRestarterSupervisor", [ref]$created)
  if (!$created) { exit 0 }
  try {
    Write-JsonAtomic -Path $SupervisorPidPath -Value ([pscustomobject]@{
      pid = $PID
      startedAt = [DateTime]::UtcNow.ToString("o")
      script = $InstalledScript
    })
    Write-Log "supervisor started pid=$PID"
    while (!(Test-Path $DisabledPath)) {
      $child = Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$InstalledScript`"", "-Run"
      ) -WindowStyle Hidden -PassThru
      $child.WaitForExit()
      if (!(Test-Path $DisabledPath)) {
        Write-Log "listener exited code=$($child.ExitCode); restarting in 5s"
        Start-Sleep -Seconds 5
      }
    }
  } finally {
    $record = Read-Json $SupervisorPidPath
    if ($null -ne $record -and [int]$record.pid -eq $PID) {
      Remove-Item -Force -ErrorAction SilentlyContinue $SupervisorPidPath
    }
    $mutex.ReleaseMutex()
    $mutex.Dispose()
  }
  exit 0
}

if ($Run -or $PSCmdlet.ParameterSetName -eq "Run") {
  $created = $false
  $mutex = New-Object System.Threading.Mutex($true, "Local\AgentmuxDiscordRestarter", [ref]$created)
  if (!$created) { exit 0 }
  try {
    $config = Read-Json $ConfigPath
    if ($null -eq $config) { throw "restarter config is missing" }
    Write-JsonAtomic -Path $PidPath -Value ([pscustomobject]@{
      pid = $PID
      startedAt = [DateTime]::UtcNow.ToString("o")
      script = $InstalledScript
    })
    Write-Log "listener started pid=$PID channel=$($config.channelId)"
    $script:Generation = [guid]::NewGuid().ToString("N")
    $state = Read-Json $StatePath
    if ($null -eq $state) {
      Initialize-State -Config $config
      $state = Read-Json $StatePath
    }
    $state.generation = $script:Generation
    if ($null -ne $state.lastAction -and $state.lastAction.status -eq "started") {
      if (Test-BridgeCore -Config $config) {
        $resume = Invoke-BridgeJson -Config $config -Command "reconcile-state" -InputValue $state
        $state = $resume.state
        Write-Log "leftover action disposition=$($resume.disposition) reason=$($resume.reason)"
      } else {
        $leftover = [string]$state.lastAction.command
        $state.lastAction.status = "blocked"
        $state.lastAction.completedAt = [DateTime]::UtcNow.ToString("o")
        $state.lastAction.stage = "runtime-unavailable-after-crash"
        $state.lastSeenId = [string]$state.lastAction.messageId
        Write-Log "leftover action $leftover fenced BLOCKED runtime-unavailable-after-crash"
      }
    }
    Write-JsonAtomic -Path $StatePath -Value $state
    while ($true) {
      try {
        Process-DiscordMessages -Config $config -State ([ref]$state)
        $state.lastPollAt = [DateTime]::UtcNow.ToString("o")
        $state.lastError = $null
        Write-JsonAtomic -Path $StatePath -Value $state
      } catch {
        $state.lastPollAt = [DateTime]::UtcNow.ToString("o")
        $state.lastError = $_.Exception.Message
        Write-JsonAtomic -Path $StatePath -Value $state
        Write-Log "poll failed: $($_.Exception.Message)"
      }
      Start-Sleep -Seconds ([int]$config.pollSeconds)
    }
  } finally {
    $record = Read-Json $PidPath
    if ($null -ne $record -and [int]$record.pid -eq $PID) {
      Remove-Item -Force -ErrorAction SilentlyContinue $PidPath
    }
    $mutex.ReleaseMutex()
    $mutex.Dispose()
  }
}
