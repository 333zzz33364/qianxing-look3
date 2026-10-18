# look2.0 isolated native-page acceptance launcher (no game playtest).
# Run from any directory with PowerShell 5.1+ and Node >=22.
[CmdletBinding()]
param(
  [ValidateRange(1,65535)][int]$Port = 4204,
  [switch]$ResumePhase13
)
$ErrorActionPreference = 'Stop'
if ($Port -eq 4173 -or $Port -eq 4174) { throw 'Ports 4173 and 4174 are reserved for existing Look/look2 sessions; use isolated 4204 or another free port.' }
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$server = Join-Path $projectRoot 'web\dist\server.js'
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) {
  throw 'Built Web server not found. Run node scripts/build.mjs web in look2.0 first.'
}
$node = Get-Command node -ErrorAction Stop
$major = [int]((& $node.Source --version).Trim() -replace '^v(\d+).*','$1')
if ($major -lt 22) { throw 'Node.js >=22 is required.' }
# Pin the served editor to the exact source and Web bundle verified in the
# 13th run. A mismatch requires new tests/build and a new evidence baseline.
$sourcePath = Join-Path $projectRoot 'editor-ui\look2.js'
$servedEditorPath = Join-Path $projectRoot 'web\dist\public\editor.js'
$expectedSourceSha256 = '7218680edcba81cec984a3660dc2e83904c7015bc736a06de63a0e542b967fa3'
$expectedServedSha256 = 'f6847e37fa357886531580aaaf458e610120818e515a94305430b5e3c0899b4b'
foreach ($checkedPath in @($sourcePath, $servedEditorPath)) {
  if (-not (Test-Path -LiteralPath $checkedPath -PathType Leaf)) {
    throw "Missing verified editor input: $checkedPath"
  }
}
$sourceSha256 = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
$servedSha256 = (Get-FileHash -LiteralPath $servedEditorPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($sourceSha256 -ne $expectedSourceSha256 -or $servedSha256 -ne $expectedServedSha256) {
  throw "Source/Web editor hash differs from the verified 382/382 baseline. Do not collect acceptance evidence from an unverified build; rerun tests/build, record new hashes, then update this launcher."
}
$serverSha256 = (Get-FileHash -LiteralPath $server -Algorithm SHA256).Hash.ToLowerInvariant()
# Opt-in restore only copies the known phase-13 archive after a digest check.
# Its original is never opened for writing and is never used as a workspace.
$seedArchive = ''
$seedArchiveSha256 = ''
$seedFileName = 'look2.0.4.save.json'
if ($ResumePhase13) {
  $seedArchive = Join-Path $projectRoot 'look2-workspace\acceptance-20261009\page-11-20261009-202342-902e6e46\workspace\look2.0.4.save.json'
  $expectedSeedSha256 = 'c1dc3fba5c2c23a042fda5f528076e0488fd7eb99b2484b8475e11d69a1cf2a7'
  if (-not (Test-Path -LiteralPath $seedArchive -PathType Leaf)) { throw 'Phase-13 acceptance archive is unavailable; no fresh workspace was created.' }
  $seedArchiveSha256 = (Get-FileHash -LiteralPath $seedArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($seedArchiveSha256 -ne $expectedSeedSha256) { throw 'Phase-13 acceptance archive differs from the paused checksum; refusing to copy it.' }
}
# Never bind an externally accessible interface or overwrite the shared workspace.
$runId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$runRoot = Join-Path $projectRoot ('look2-workspace\acceptance-20261009\page-11-' + $runId)
New-Item -ItemType Directory -Path $runRoot -ErrorAction Stop | Out-Null
$workspace = Join-Path $runRoot 'workspace'
New-Item -ItemType Directory -Path $workspace -ErrorAction Stop | Out-Null
if ($ResumePhase13) {
  $seedDestination = Join-Path $workspace $seedFileName
  Copy-Item -LiteralPath $seedArchive -Destination $seedDestination -ErrorAction Stop
  $copiedSha256 = (Get-FileHash -LiteralPath $seedDestination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($copiedSha256 -ne $seedArchiveSha256) { throw 'Copied acceptance archive failed digest verification; do not run native acceptance.' }
}
$evidence = Join-Path $runRoot 'evidence'
New-Item -ItemType Directory -Path $evidence -ErrorAction Stop | Out-Null
$manifest = [ordered]@{
  runId = $runId
  startedAt = (Get-Date).ToString('o')
  url = ('http://127.0.0.1:' + $Port + '/editor')
  workspace = $workspace
  evidence = $evidence
  resumedPhase13 = [bool]$ResumePhase13
  seededArchiveFile = $(if ($ResumePhase13) { $seedFileName } else { '' })
  seededArchiveSha256 = $seedArchiveSha256
  verifiedBaseline = '2026-10-09 phase13: 382/382, Web/DSH/MCP builds, ST02 project rename'
  sourceEditorSha256 = $sourceSha256
  servedEditorSha256 = $servedSha256
  servedServerSha256 = $serverSha256
  nodeVersion = (& $node.Source --version).Trim()
  publishedPackageVersion = '2.0.17 (older release artifacts, not this served build)'
  currentStatus = 'unverified'
  instructions = 'Browser/page acceptance is manual; save screenshots/logs under evidence, do not click Play without explicit permission.'
}
($manifest | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath (Join-Path $runRoot 'run-meta.json') -Encoding UTF8
Write-Host "Isolated workspace: $workspace"
Write-Host "Evidence directory: $evidence"
Write-Host "Open this URL manually: $($manifest.url)"
Write-Host 'Do not use the Play button without separate authorization.'
Write-Host 'Press Ctrl+C here to stop the acceptance server.'
$serverArgs = @($server, '--workspace', $workspace, '--host', '127.0.0.1', '--port', [string]$Port)
if ($ResumePhase13) {
  $serverArgs += @('--file', $seedFileName)
  Write-Host "Loaded verified phase-13 archive copy: $seedFileName"
}
Push-Location $projectRoot
try {
  & $node.Source @serverArgs
  if ($LASTEXITCODE -ne 0) { throw "Web server exited with code $LASTEXITCODE. Evidence remains in the isolated directory." }
} finally { Pop-Location }
