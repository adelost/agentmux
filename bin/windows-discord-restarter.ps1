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
  [int]$PollSeconds = 3,
  [Parameter(ParameterSetName = "Run")]
  [switch]$Run,
  [Parameter(ParameterSetName = "Supervise")]
  [switch]$Supervise,
  [Parameter(ParameterSetName = "Start")]
  [switch]$Start,
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
  $Value | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -Path $temporary
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
  param(
    [string]$Method,
    [string]$Route,
    [object]$Body = $null
  )
  $headers = @{
    Authorization = "Bot $(Get-Token)"
    "User-Agent" = "agentmux-windows-restarter/1"
  }
  $parameters = @{
    Uri = "https://discord.com/api/v10$Route"
    Method = $Method
    Headers = $headers
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
  param(
    [string]$FilePath,
    [string]$Arguments,
    [int]$TimeoutSeconds
  )
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
  $stdoutText = $stdout.Result.Replace("`0", "").Trim()
  $stderrText = $stderr.Result.Replace("`0", "").Trim()
  return [pscustomobject]@{
    ok = $process.ExitCode -eq 0
    timedOut = $false
    exitCode = $process.ExitCode
    stdout = $stdoutText
    stderr = $stderrText
  }
}

function Invoke-WslScript {
  param(
    [object]$Config,
    [string]$Script,
    [int]$TimeoutSeconds = 90
  )
  Assert-Identifier $Config.distro "distro"
  Assert-Identifier $Config.linuxUser "linux user"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
  # WSL's Win32 argv parser keeps quotes around -d/-u values when launched
  # through ProcessStartInfo.Arguments. The validated identifiers are safe to
  # pass unquoted and match direct wsl.exe invocation semantics.
  $arguments = "-d $($Config.distro) -u $($Config.linuxUser) -- bash -lc `"echo $encoded | base64 -d | bash`""
  return Invoke-ProcessBounded -FilePath $WslExe -Arguments $arguments -TimeoutSeconds $TimeoutSeconds
}

function Get-BridgeRescueScript {
  return @'
set -u
AMUX_BIN="$(command -v amux 2>/dev/null || true)"
if [ -z "$AMUX_BIN" ]; then
  AMUX_BIN="$(find "$HOME/.nvm/versions/node" -path '*/bin/amux' -type l 2>/dev/null | sort -V | tail -n 1)"
fi
[ -n "$AMUX_BIN" ] || { echo 'RESCUE_FAILED reason=amux-not-found'; exit 1; }
ROOT="$(dirname "$(dirname "$(readlink -f "$AMUX_BIN")")")"
AMUX_BIN="$AMUX_BIN" timeout 85s bash "$ROOT/bin/bridge-rescue.sh"
'@
}

function Get-BridgeStartScript {
  return @'
set -u
AMUX_BIN="$(command -v amux 2>/dev/null || true)"
if [ -z "$AMUX_BIN" ]; then
  AMUX_BIN="$(find "$HOME/.nvm/versions/node" -path '*/bin/amux' -type l 2>/dev/null | sort -V | tail -n 1)"
fi
[ -n "$AMUX_BIN" ] || { echo 'START_FAILED reason=amux-not-found'; exit 1; }
"$AMUX_BIN" serve --detach
for _ in $(seq 1 45); do
  if [ -r /tmp/agentmux.pid ] && [ -r /tmp/agentmux.ready ] \
      && [ "$(cat /tmp/agentmux.pid)" = "$(cat /tmp/agentmux.ready)" ]; then
    pid="$(cat /tmp/agentmux.pid)"
    kill -0 "$pid" 2>/dev/null && { echo "START_OK pid=$pid"; exit 0; }
  fi
  sleep 1
done
echo 'START_FAILED reason=not-ready'
exit 1
'@
}

function Restart-Wsl {
  param([object]$Config)
  $stop = Invoke-ProcessBounded -FilePath $WslExe -Arguments "--shutdown" -TimeoutSeconds 45
  if (!$stop.ok) {
    return [pscustomobject]@{ ok = $false; stage = "wsl-stop"; detail = $stop.stderr }
  }
  Start-Sleep -Seconds 4
  $start = Invoke-WslScript -Config $Config -Script (Get-BridgeStartScript) -TimeoutSeconds 90
  return [pscustomobject]@{
    ok = $start.ok
    stage = "wsl-shutdown"
    detail = (($start.stdout, $start.stderr) -join " ").Trim()
  }
}

function Invoke-Rescue {
  param([object]$Config, [bool]$Hard)
  if ($Hard) {
    return Restart-Wsl -Config $Config
  }
  $soft = Invoke-WslScript -Config $Config -Script (Get-BridgeRescueScript) -TimeoutSeconds 100
  if ($soft.ok -and $soft.stdout -match "RESCUE_OK") {
    return [pscustomobject]@{ ok = $true; stage = "bridge"; detail = $soft.stdout }
  }
  $detail = (($soft.stdout, $soft.stderr) -join " ").Trim()
  Write-Log "soft rescue failed without escalation: $detail"
  return [pscustomobject]@{ ok = $false; stage = "bridge"; detail = $detail }
}

function Process-DiscordMessages {
  param([object]$Config, [ref]$State)
  $after = [string]$State.Value.lastSeenId
  $route = "/channels/$($Config.channelId)/messages?limit=50"
  if ($after) { $route += "&after=$after" }
  $messages = @(Invoke-Discord -Method Get -Route $route)
  if ($messages.Count -eq 0) { return }
  $messages = @($messages | Sort-Object { [uint64]($_.id) })
  foreach ($message in $messages) {
    $State.Value.lastSeenId = [string]$message.id
    $State.Value.lastPollAt = [DateTime]::UtcNow.ToString("o")
    Write-JsonAtomic -Path $StatePath -Value $State.Value
    if ([string]$message.author.id -ne [string]$Config.authorizedUserId) { continue }
    $command = ([string]$message.content).Trim().ToLowerInvariant()
    if ($command -ne "//restart" -and $command -ne "//hardrestart") { continue }
    $hard = $command -eq "//hardrestart"
    $State.Value.lastAction = [pscustomobject]@{
      messageId = [string]$message.id
      command = $command
      status = "started"
      startedAt = [DateTime]::UtcNow.ToString("o")
      completedAt = $null
      stage = $null
    }
    Write-JsonAtomic -Path $StatePath -Value $State.Value
    Write-Log "authorized $command message=$($message.id)"
    Send-DiscordReceipt -Config $Config -Message (
      "AMUX rescue mottagen av Windows-restartern. Försöker {0} återställning…" -f
      $(if ($hard) { "full WSL" } else { "bridge" })
    )
    $result = Invoke-Rescue -Config $Config -Hard:$hard
    $State.Value.lastAction.status = $(if ($result.ok) { "completed" } else { "failed" })
    $State.Value.lastAction.completedAt = [DateTime]::UtcNow.ToString("o")
    $State.Value.lastAction.stage = $result.stage
    Write-JsonAtomic -Path $StatePath -Value $State.Value
    Write-Log "rescue status=$($State.Value.lastAction.status) stage=$($result.stage)"
    if ($result.ok) {
      Send-DiscordReceipt -Config $Config -Message "AMUX rescue klar via $($result.stage). Bryggan är startad."
    } else {
      Send-DiscordReceipt -Config $Config -Message "AMUX rescue misslyckades vid $($result.stage). Kontrollera Windows-loggen."
    }
  }
}

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
  if ($null -ne (Get-LiveSupervisorProcess) -and $null -ne (Get-LiveRestarterProcess)) { return }
  if (!(Test-Path $InstalledScript) -or !(Test-Path $ConfigPath) -or !(Test-Path $CredentialPath)) {
    throw "restarter is not installed"
  }
  Remove-Item -Force -ErrorAction SilentlyContinue $DisabledPath
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$InstalledScript`"", "-Supervise"
  ) -WindowStyle Hidden
  for ($i = 0; $i -lt 100; $i++) {
    if ($null -ne (Get-LiveSupervisorProcess) -and $null -ne (Get-LiveRestarterProcess)) { return }
    Start-Sleep -Milliseconds 100
  }
  throw "restarter did not start"
}

function Initialize-State {
  param([object]$Config)
  $messages = @(Invoke-Discord -Method Get -Route "/channels/$($Config.channelId)/messages?limit=1")
  $latest = $(if ($messages.Count -gt 0) { [string]$messages[0].id } else { "" })
  Write-JsonAtomic -Path $StatePath -Value ([pscustomobject]@{
    lastSeenId = $latest
    lastPollAt = $null
    lastError = $null
    lastAction = $null
  })
}

if ($Install) {
  if ($ChannelId -notmatch "^\d{17,20}$" -or $AuthorizedUserId -notmatch "^\d{17,20}$") {
    throw "channel and authorized user must be Discord snowflake ids"
  }
  Assert-Identifier $Distro "distro"
  Assert-Identifier $LinuxUser "linux user"
  if ($PollSeconds -lt 2 -or $PollSeconds -gt 30) { throw "poll seconds must be 2..30" }
  $token = [Console]::In.ReadToEnd().Trim()
  if (!$token) { throw "Discord token was not provided on stdin" }
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  Copy-Item -Force $MyInvocation.MyCommand.Path $InstalledScript
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
    pollSeconds = $PollSeconds
  }
  Write-JsonAtomic -Path $ConfigPath -Value $config
  Initialize-State -Config $config
  Stop-Restarter | Out-Null
  Remove-Item -Force -ErrorAction SilentlyContinue $DisabledPath
  $taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstalledScript`" -Supervise"
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & schtasks.exe /Create /TN $TaskName /SC ONLOGON /RL LIMITED /F /TR $taskCommand 2>$null | Out-Null
  $taskExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorAction
  $persistence = "scheduled-task"
  if ($taskExitCode -ne 0) {
    $runCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstalledScript`" -Supervise"
    New-Item -Force -Path $RunKey | Out-Null
    Set-ItemProperty -Path $RunKey -Name $TaskName -Value $runCommand
    $persistence = "hkcu-run"
  } else {
    Remove-ItemProperty -Path $RunKey -Name $TaskName -ErrorAction SilentlyContinue
  }
  Start-Restarter
  Write-Output "INSTALLED channel=$ChannelId user=$AuthorizedUserId persistence=$persistence"
  exit 0
}

if ($Start) {
  Start-Restarter
  Write-Output "STARTED"
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
    running = $null -ne $process -and $null -ne $supervisor
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
    $state = Read-Json $StatePath
    if ($null -eq $state) {
      Initialize-State -Config $config
      $state = Read-Json $StatePath
    }
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
