$ErrorActionPreference = "Continue"

$appDirectory = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $appDirectory "output\service-logs"
$logFile = Join-Path $logDirectory "agent-4174.log"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
Set-Location -LiteralPath $appDirectory

while ($true) {
  & "E:\node.exe" "server\agent-planner-app.mjs" *>> $logFile
  Start-Sleep -Seconds 2
}
