[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 4180,
    [ValidateSet('127.0.0.1', '0.0.0.0')]
    [string]$BindAddress = '0.0.0.0',
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$appDirectory = Split-Path -Parent $PSScriptRoot
$ConfigDirectory = $appDirectory
$envFiles = @('.env.knowledge.local', '.env.image-search.local', '.env.local')

if ($Port -eq 4173) {
    throw 'Port 4173 is reserved for the fixed workflow. Use 4180 for the agent.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js was not found. Open a terminal with Node.js on PATH.'
}

$nodeArguments = @()
foreach ($name in $envFiles) {
    $file = Join-Path $ConfigDirectory $name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Required configuration file is missing: $file"
    }
    $nodeArguments += "--env-file=$file"
}
$nodeArguments += 'server/agent-planner-app.mjs'

$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($listener) {
    $processIds = ($listener.OwningProcess | Sort-Object -Unique) -join ', '
    throw "Port $Port is already in use (PID: $processIds). Stop the existing service in its terminal before starting again."
}

Write-Host "Agent URL: http://127.0.0.1:$Port/agent"
Write-Host "Listen address: $BindAddress"
if ($BindAddress -eq '0.0.0.0') {
    $networkAddresses = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.HardwareInterface } | ForEach-Object { $_.IPv4Address.IPAddress } | Where-Object { $_ -notlike '169.254.*' } | Sort-Object -Unique
    foreach ($address in $networkAddresses) {
        Write-Host "LAN Agent URL: http://${address}:$Port/agent"
    }
}
Write-Host "Configuration directory: $ConfigDirectory"
if ($CheckOnly) {
    Write-Host 'Startup checks passed. No service was started.'
    return
}

$previousPort = $env:AGENT_PLANNER_PORT
$previousBindAddress = $env:AGENT_PLANNER_HOST
Push-Location -LiteralPath $appDirectory
try {
    $env:AGENT_PLANNER_PORT = [string]$Port
    $env:AGENT_PLANNER_HOST = $BindAddress
    Write-Host 'Starting in this terminal. Press Ctrl+C to stop.'
    & node @nodeArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Agent process exited with code $LASTEXITCODE."
    }
} finally {
    $env:AGENT_PLANNER_PORT = $previousPort
    $env:AGENT_PLANNER_HOST = $previousBindAddress
    Pop-Location
}
