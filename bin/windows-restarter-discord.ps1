# Discord message loop for windows-discord-restarter.ps1.

function Process-DiscordMessages {
  param([object]$Config, [ref]$State)
  $after = [string]$State.Value.lastSeenId
  $route = "/channels/$($Config.channelId)/messages?limit=50"
  if ($after) { $route += "&after=$after" }
  $messages = @(Invoke-Discord -Method Get -Route $route)
  if ($messages.Count -eq 0) { return }
  $messages = @($messages | Sort-Object { [uint64]($_.id) })
  foreach ($message in $messages) {
    if ($message.author.bot -eq $true -or
        [string]$message.author.id -ne [string]$Config.authorizedUserId -or
        !([string]$message.content).Trim().StartsWith("//")) {
      $State.Value.lastSeenId = [string]$message.id
      Write-JsonAtomic -Path $StatePath -Value $State.Value
      continue
    }
    if (!(Test-BridgeCore -Config $Config)) {
      Send-DiscordReceipt -Config $Config -Message "AMUX BLOCKED runtime-unavailable: $($script:BridgeCoreError)"
      $State.Value.lastSeenId = [string]$message.id
      Write-JsonAtomic -Path $StatePath -Value $State.Value
      continue
    }
    $plan = Invoke-BridgeJson -Config $Config -Command "plan-message" -InputValue ([pscustomobject]@{
      messageId = [string]$message.id
      text = [string]$message.content
      generation = $script:Generation
      nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    })
    if ($plan.accepted -ne $true) {
      $State.Value.lastSeenId = [string]$message.id
      Write-JsonAtomic -Path $StatePath -Value $State.Value
      continue
    }

    $action = $plan.action
    $command = [string]$plan.parsed.command
    $State.Value.lastAction = $action
    Write-JsonAtomic -Path $StatePath -Value $State.Value
    Write-Log "accepted $command message=$($message.id) generation=$($script:Generation)"
    $outcome = Invoke-WindowsCommand -Config $Config -Plan $plan
    $action.status = $(if ($outcome.ok) { "completed" } else { "failed" })
    $action.completedAt = [DateTime]::UtcNow.ToString("o")
    $action.stage = $outcome.stage
    $State.Value.lastAction = $action
    $State.Value.lastSeenId = [string]$message.id
    $State.Value.lastPollAt = [DateTime]::UtcNow.ToString("o")
    Write-JsonAtomic -Path $StatePath -Value $State.Value
    Write-Log "action $command status=$($action.status) stage=$($action.stage)"
  }
}

function Invoke-WindowsCommand {
  param([object]$Config, [object]$Plan)
  $command = [string]$Plan.parsed.command
  if ($command -eq "status") {
    $observation = Get-WslObservation -Config $Config
    Send-DiscordReceipt -Config $Config -Message (Format-Status -Config $Config -Observation $observation)
    return [pscustomobject]@{ ok = $true; stage = "status" }
  }
  if ($command -eq "logs") {
    Send-DiscordReceipt -Config $Config -Message (Get-BoundedLogs -Config $Config)
    return [pscustomobject]@{ ok = $true; stage = "logs" }
  }
  if ($command -eq "start-wsl") {
    $before = Get-WslObservation -Config $Config
    $result = $(if ($before.wslReachable) {
      [pscustomobject]@{ ok = $true; stage = "start-wsl"; detail = "already-online" }
    } else {
      Start-WslBounded -Config $Config
    })
    $after = Get-WslObservation -Config $Config
    Send-DiscordReceipt -Config $Config -Message "$(Format-Status -Config $Config -Observation $after)`nstep=start-wsl detail=$($result.detail)"
    return [pscustomobject]@{ ok = $result.ok; stage = $result.stage }
  }
  if ($command -eq "start-bridge") {
    $before = Get-WslObservation -Config $Config
    $verdict = Get-StatusVerdict -Config $Config -Observation $before
    $result = if ($verdict.nextStep -eq "start-bridge") {
      Start-BridgeForeground -Config $Config
    } elseif ($verdict.outcome -eq "READY") {
      [pscustomobject]@{ ok = $true; stage = "start-bridge"; detail = "already-ready" }
    } else {
      [pscustomobject]@{ ok = $false; stage = "start-bridge"; detail = [string]$verdict.reason }
    }
    $after = Get-WslObservation -Config $Config
    Send-DiscordReceipt -Config $Config -Message "$(Format-Status -Config $Config -Observation $after)`nstep=start-bridge detail=$($result.detail)"
    return [pscustomobject]@{ ok = $result.ok; stage = $result.stage }
  }
  if ($command -eq "recover") {
    $result = Invoke-Recovery -Config $Config
    $status = Format-Status -Config $Config -Observation $result.observation
    Send-DiscordReceipt -Config $Config -Message "AMUX recovery=$($result.outcome) reason=$($result.reason)`n$status"
    return [pscustomobject]@{ ok = $result.outcome -eq "RECOVERED"; stage = "recover:$($result.outcome.ToLowerInvariant())" }
  }
  if ($command -eq "restart") {
    Send-DiscordReceipt -Config $Config -Message "AMUX explicit bridge rescue accepted."
    $result = Invoke-Rescue -Config $Config -Hard:$false
    Send-DiscordReceipt -Config $Config -Message $(if ($result.ok) { "AMUX RECOVERED stage=$($result.stage)." } else { "AMUX BLOCKED stage=$($result.stage)." })
    return [pscustomobject]@{ ok = $result.ok; stage = $result.stage }
  }
  if ($command -eq "hardrestart" -or $command -eq "restart-wsl") {
    return Invoke-FencedWslRestart -Config $Config -Plan $Plan
  }
  Send-DiscordReceipt -Config $Config -Message "AMUX BLOCKED unsupported-command:$command"
  return [pscustomobject]@{ ok = $false; stage = "unsupported-command:$command" }
}

function Invoke-FencedWslRestart {
  param([object]$Config, [object]$Plan)
  $command = [string]$Plan.parsed.command
  $receiptId = [string]$Plan.parsed.args.receipt
  $verified = $(if ($receiptId) {
    Get-VerifiedRestartReceipt -Config $Config -ReceiptId $receiptId
  } else {
    [pscustomobject]@{ ok = $false; reason = "restart-ready-receipt-missing"; path = $null; receipt = $null }
  })
  if (!$verified.ok) {
    Send-DiscordReceipt -Config $Config -Message "AMUX BLOCKED $($verified.reason)"
    return [pscustomobject]@{ ok = $false; stage = $verified.reason }
  }
  $observation = Get-WslObservation -Config $Config
  $receipt = $verified.receipt
  $check = Invoke-BridgeNode -Config $Config -NodeArguments (
    "destructive-check --command $command --receipt `"$($verified.path)`" " +
    "--receipt-id $receiptId --boot-id $($observation.bootId) " +
    "--fleet-generation $($receipt.fleetGeneration) --source-sha $($observation.release.sourceSha)"
  )
  try { $verdict = $check.stdout | ConvertFrom-Json } catch { $verdict = $null }
  if ($null -eq $verdict -or $verdict.allow -ne $true) {
    $reason = $(if ($null -ne $verdict) { [string]$verdict.reason } else { "verdict-unreadable" })
    Send-DiscordReceipt -Config $Config -Message "AMUX BLOCKED $reason"
    return [pscustomobject]@{ ok = $false; stage = $reason }
  }
  Send-DiscordReceipt -Config $Config -Message "AMUX restart authorized by receipt $receiptId. Executing exactly one WSL shutdown/start."
  $result = Invoke-Rescue -Config $Config -Hard:$true
  Send-DiscordReceipt -Config $Config -Message $(if ($result.ok) { "AMUX RECOVERED stage=$($result.stage)." } else { "AMUX PARTIAL stage=$($result.stage): $($result.detail)" })
  return [pscustomobject]@{ ok = $result.ok; stage = $result.stage }
}
