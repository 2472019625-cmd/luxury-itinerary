$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$healthUrl = "http://127.0.0.1:4173/api/health"

try {
  Invoke-RestMethod $healthUrl -TimeoutSec 2 | Out-Null
} catch {
  $output = Join-Path $root "output"
  New-Item -ItemType Directory -Force -Path $output | Out-Null
  Start-Process -FilePath "node" `
    -ArgumentList "server/app.mjs" `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $output "server.log") `
    -RedirectStandardError (Join-Path $output "server-error.log")
  Start-Sleep -Seconds 2
}

Start-Process "http://127.0.0.1:4173/"
