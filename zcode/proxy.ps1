# ZCode WorkBuddy proxy - start/stop/status
# Usage:
#   powershell -File proxy.ps1 start
#   powershell -File proxy.ps1 stop
#   powershell -File proxy.ps1 status
param(
  [Parameter(Position = 0)]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Proxy = Join-Path $Dir 'proxy.mjs'
$PidFile = Join-Path $Dir 'proxy.pid'
$LogFile = Join-Path $Dir 'proxy.log'
$Port = 8400

function Get-ProxyPid {
  if (Test-Path $PidFile) {
    $stored = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($stored -match '^\d+$') {
      $p = Get-Process -Id $stored -ErrorAction SilentlyContinue
      if ($p -and $p.ProcessName -eq 'node') { return [int]$stored }
    }
  }
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) {
    $p = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') { return $conn.OwningProcess }
  }
  return $null
}

switch ($Action) {
  'start' {
    $existing = Get-ProxyPid
    if ($existing) {
      Write-Host "[proxy] already running (pid $existing, port $Port)"
      exit 0
    }
    $node = (Get-Command node.exe).Source
    $p = Start-Process -FilePath $node -ArgumentList "`"$Proxy`"" -WindowStyle Hidden `
      -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" -PassThru
    Set-Content -Path $PidFile -Value $p.Id
    Start-Sleep -Milliseconds 900
    $health = $null
    try { $health = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 5).Content } catch {}
    if ($health) {
      Write-Host "[proxy] started (pid $($p.Id), port $Port)"
      Write-Host "[proxy] $health"
    } else {
      Write-Warning "[proxy] process started (pid $($p.Id)) but health check failed; see $LogFile.err"
    }
  }
  'stop' {
    $existing = Get-ProxyPid
    if ($existing) {
      Stop-Process -Id $existing -Force
      Write-Host "[proxy] stopped (pid $existing)"
    } else {
      Write-Host "[proxy] not running"
    }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
  }
  'restart' {
    & $MyInvocation.MyCommand.Path stop
    & $MyInvocation.MyCommand.Path start
  }
  'status' {
    $existing = Get-ProxyPid
    if ($existing) {
      $health = $null
      try { $health = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 5).Content } catch {}
      Write-Host "[proxy] running (pid $existing, port $Port)"
      Write-Host "[proxy] $health"
    } else {
      Write-Host "[proxy] not running"
    }
  }
}
