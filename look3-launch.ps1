param(
    [ValidateRange(1024, 65515)][int]$Port = 4260,
    [string]$WorkspacePath = '',
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPath = Join-Path $projectRoot 'web\dist\server.js'
if (-not $WorkspacePath) { $WorkspacePath = Join-Path $projectRoot 'look3-workspace' }
$workspacePath = [System.IO.Path]::GetFullPath($WorkspacePath)
if (-not (Test-Path -LiteralPath $serverPath)) { throw "千星look3 Web build not found: $serverPath" }
$hasher = [System.Security.Cryptography.SHA256]::Create()
try { $expectedBuild = [System.BitConverter]::ToString($hasher.ComputeHash([System.IO.File]::ReadAllBytes($serverPath))).Replace('-', '').ToLowerInvariant() }
finally { $hasher.Dispose() }
$probeHeaders = @{}
if ($env:QXQY_WEB_PASSWORD) {
    $credentials = [System.Text.Encoding]::UTF8.GetBytes('simulator:' + $env:QXQY_WEB_PASSWORD)
    $probeHeaders['Authorization'] = 'Basic ' + [System.Convert]::ToBase64String($credentials)
}

function Test-Look3Server([int]$CandidatePort) {
    try {
        $baseUrl = "http://127.0.0.1:$CandidatePort"
        $health = Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 2
        if ($health.status -ne 'ok' -or $health.buildId -ne $expectedBuild) { return $false }
        if ($env:QXQY_WEB_PASSWORD) {
            # A matching instance started without a password would ignore our
            # credentials. Verify that it actually requires authentication.
            try {
                Invoke-RestMethod -Uri "$baseUrl/api/state" -TimeoutSec 2 | Out-Null
                return $false
            } catch {
                if ($null -eq $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) { return $false }
            }
        }
        $state = Invoke-RestMethod -Uri "$baseUrl/api/state" -Headers $probeHeaders -TimeoutSec 2
        if (-not $state.ok) { return $false }
        $actual = [System.IO.Path]::GetFullPath([string]$state.value.workspace).TrimEnd('\')
        $expected = $workspacePath.TrimEnd('\')
        return [string]::Equals($actual, $expected, [System.StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function Test-PortInUse([int]$CandidatePort) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $CandidatePort)
    try {
        $listener.Server.ExclusiveAddressUse = $true
        $listener.Start()
        return $false
    } catch { return $true }
    finally { $listener.Stop() }
}

# Reuse only the current backend with the same workspace.
# Keep old processes and their unsaved editor sessions alive.
$candidates = @($Port..($Port + 19))
$availablePorts = @()
$selectedPort = $null
foreach ($candidate in $candidates) {
    if (Test-PortInUse $candidate) {
        if (Test-Look3Server $candidate) { $selectedPort = $candidate; break }
    } else { $availablePorts += $candidate }
}

if ($null -eq $selectedPort) {
    if (-not (Test-Path -LiteralPath $workspacePath)) { New-Item -ItemType Directory -Path $workspacePath | Out-Null }
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    foreach ($candidate in $availablePorts) {
        # A concurrent launcher may have started a matching process meanwhile.
        if (Test-PortInUse $candidate) {
            if (Test-Look3Server $candidate) { $selectedPort = $candidate; break }
            continue
        }
        $arguments = @('"' + $serverPath + '"', '--workspace', '"' + $workspacePath + '"', '--host', '127.0.0.1', '--port', [string]$candidate)
        $serverProcess = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
        for ($attempt = 0; $attempt -lt 80; $attempt++) {
            if ((Test-PortInUse $candidate) -and (Test-Look3Server $candidate)) { $selectedPort = $candidate; break }
            if ($serverProcess.HasExited) { break }
            Start-Sleep -Milliseconds 250
        }
        if ($null -ne $selectedPort) { break }
        if (-not $serverProcess.HasExited) { throw "千星look3 is still starting on port $candidate; retry after it is ready." }
    }
    if ($null -eq $selectedPort) { throw "No available 千星look3 port in $Port-$($Port + 19). Close unused services and retry." }
}
$url = "http://127.0.0.1:$selectedPort/editor"
Write-Output "LOOK3_URL=$url"
if (-not $NoOpen) { Start-Process -FilePath $url }
