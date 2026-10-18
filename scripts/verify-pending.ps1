# look2.0 current source verification; no releases, installed packages, or user archives changed.
# PowerShell 5.1+ / PowerShell 7+, run from any directory.
[CmdletBinding()]
param(
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runId = [guid]::NewGuid().ToString('N').Substring(0, 8)
$reportDir = Join-Path $projectRoot ("look2-workspace\acceptance-20261009\verification-15-" + $stamp + '-' + $runId)
New-Item -ItemType Directory -Path $reportDir -ErrorAction Stop | Out-Null
$results = New-Object 'System.Collections.Generic.List[object]'
$steps = @(
  @{ Name='01-check-editor'; Exe='node'; Args=@('--check','editor-ui/look2.js') },
  @{ Name='02-check-resources'; Exe='node'; Args=@('--check','editor-ui/look2-resources.js') },
  @{ Name='03-check-timeline-tests'; Exe='node'; Args=@('--check','studio/test/editor-timeline.test.mjs') },
  @{ Name='04-check-resource-tests'; Exe='node'; Args=@('--check','studio/test/editor-resource-options.test.mjs') },
  @{ Name='05-check-player-tests'; Exe='node'; Args=@('--check','studio/test/look2-player.test.mjs') },
  @{ Name='06-timeline-special'; Exe='node'; Args=@('--test','studio/test/editor-timeline.test.mjs') },
  @{ Name='07-resource-special'; Exe='node'; Args=@('--test','studio/test/editor-resource-options.test.mjs') },
  @{ Name='08-player-special'; Exe='node'; Args=@('--test','studio/test/look2-player.test.mjs') },
  @{ Name='09-check-acceptance-core'; Exe='node'; Args=@('--check','scripts/acceptance-ledger-core.mjs') },
  @{ Name='10-check-acceptance-cli'; Exe='node'; Args=@('--check','scripts/check-acceptance-ledger.mjs') },
  @{ Name='11-check-acceptance-tests'; Exe='node'; Args=@('--check','studio/test/acceptance-ledger.test.mjs') },
  @{ Name='12-acceptance-ledger-special'; Exe='node'; Args=@('--test','studio/test/acceptance-ledger.test.mjs') },
  @{ Name='13-acceptance-evidence-audit'; Exe='node'; Args=@('scripts/check-acceptance-ledger.mjs') },
  @{ Name='13b-phase19-documentary-audit'; Exe='node'; Args=@('scripts/phase19-evidence-audit.mjs') },
  @{ Name='14-full-regression'; Exe='corepack'; Args=@('pnpm','test') }
)
if (-not $SkipBuild) {
  $steps += @{ Name='15-build-all'; Exe='node'; Args=@('scripts/build.mjs') }
}
$failed = $false
Push-Location $projectRoot
try {
  foreach ($step in $steps) {
    $log = Join-Path $reportDir ($step.Name + '.log')
    $started = (Get-Date).ToString('o')
    $code = 127
    Write-Host ('> ' + $step.Exe + ' ' + ($step.Args -join ' '))
    try {
      $stepArgs = [string[]]$step.Args
      $nativeErrorPreference = $ErrorActionPreference
      try {
        # Windows PowerShell 5.1 can promote a native stderr line into a
        # terminating error with Stop. Record stderr, rely on the real exit code.
        $ErrorActionPreference = 'Continue'
        & $step.Exe @stepArgs *> $log
        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 0 }
      } finally {
        $ErrorActionPreference = $nativeErrorPreference
      }
    } catch {
      ($_ | Out-String) | Out-File -FilePath $log -Encoding utf8 -Append
    }
    $item = [pscustomobject]@{
      step = $step.Name
      executable = $step.Exe
      arguments = $step.Args
      exitCode = $code
      startedAt = $started
      finishedAt = (Get-Date).ToString('o')
      logFile = [System.IO.Path]::GetFileName($log)
    }
    $results.Add($item)
    Write-Host ("  exitCode=" + $code + "; log=" + $log)
    if ($code -ne 0) {
      $failed = $true
      Write-Warning ('Failed at ' + $step.Name + '; skipping later steps so results cannot be misread as a passing candidate.')
      break
    }
  }
} finally {
  Pop-Location
  $summary = [ordered]@{
    project = 'look2.0'
    baselinePublishedVersion = '2.0.17'
    runDate = (Get-Date).ToString('o')
    projectRoot = $projectRoot
    isComplete = (-not $failed -and $results.Count -eq $steps.Count)
    ranSteps = $results.Count
    requestedSteps = $steps.Count
    steps = @($results.ToArray())
    caveat = 'This runs source checks, phase19 saved-evidence identity, Node tests and builds only. Passing does not close six pending independent native-browser scopes, UI07 independent review, package installs, DSH Desktop/CLI or game-host acceptance.'
  }
  ($summary | ConvertTo-Json -Depth 8) | Out-File -FilePath (Join-Path $reportDir 'run-summary.json') -Encoding utf8
  Write-Host ('Report: ' + (Join-Path $reportDir 'run-summary.json'))
}
if ($failed) { exit 1 }
exit 0
