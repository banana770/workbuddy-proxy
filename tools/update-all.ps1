<#
  WorkBuddy 模型列表 —— 一键更新（DSH + ZCode + Codex）
  ====================================================
  桌面快捷方式指向本脚本。做三件事：
    1. 从 WorkBuddy 上游实时拉取模型目录
    2. 同步到五处：DSH 插件兜底表 / zcode 代理 / zcode 配置 / codex 代理 / cc-switch
    3. 重启两个反代进程，让新列表生效

  用法：双击桌面快捷方式即可（或 powershell -File update-all.ps1）
#>

$ErrorActionPreference = 'Continue'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$Root        = Split-Path -Parent $MyInvocation.MyCommand.Path
$SyncScript  = Join-Path $Root 'sync-model-catalog.mjs'
$AutostartDir = Join-Path (Split-Path -Parent $Root) 'workbuddy-proxy-autostart'

function Write-Title($text) {
  Write-Host ''
  Write-Host ('─' * 58) -ForegroundColor DarkGray
  Write-Host "  $text" -ForegroundColor Cyan
  Write-Host ('─' * 58) -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '  WorkBuddy 模型列表 · 一键更新' -ForegroundColor White
Write-Host '  (DSH + ZCode + Codex)' -ForegroundColor DarkGray

if (-not (Test-Path $SyncScript)) {
  Write-Host ''
  Write-Host "  ❌ 找不到同步脚本：$SyncScript" -ForegroundColor Red
  Read-Host '  按回车退出'
  exit 1
}

# ---------------------------------------------------------------- 1. 同步

Write-Title '第 1 步 / 2：从上游拉取并同步模型目录'

& node $SyncScript
$syncOk = ($LASTEXITCODE -eq 0)

if (-not $syncOk) {
  Write-Host ''
  Write-Host '  ⚠️ 同步失败（多半是 WorkBuddy 桌面 App 没登录，或网络不通）' -ForegroundColor Yellow
  Write-Host '     请确认桌面 App 处于登录状态后重试。' -ForegroundColor Yellow
}

# ------------------------------------------------------- 2. 重启两个反代

Write-Title '第 2 步 / 2：重启两个反代进程'

$proxies = @(
  @{ Label = 'ZCode'; Port = 8400; Vbs = 'start-zcode-proxy.vbs' },
  @{ Label = 'Codex'; Port = 8401; Vbs = 'start-codex-proxy.vbs' }
)

foreach ($p in $proxies) {
  # 找出占用该端口的进程并结束
  $line = netstat -ano | Select-String ":$($p.Port)\s+.*LISTENING"
  if ($line) {
    $targetPid = ($line -split '\s+')[-1]
    if ($targetPid -match '^\d+$') {
      Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
      Write-Host "  $($p.Label) :$($p.Port)  已停止旧进程 (pid $targetPid)" -ForegroundColor DarkGray
      Start-Sleep -Milliseconds 900
    }
  } else {
    Write-Host "  $($p.Label) :$($p.Port)  原本没在跑" -ForegroundColor DarkGray
  }

  $vbs = Join-Path $AutostartDir $p.Vbs
  if (Test-Path $vbs) {
    Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`"" -WindowStyle Hidden
    Write-Host "  $($p.Label) :$($p.Port)  已重新启动" -ForegroundColor Green
  } else {
    Write-Host "  $($p.Label) :$($p.Port)  ⚠️ 找不到启动脚本 $($p.Vbs)" -ForegroundColor Yellow
  }
}

Start-Sleep -Seconds 4

# ------------------------------------------------------------- 3. 结果

Write-Title '结果'

foreach ($p in $proxies) {
  $ok = $false
  $models = '?'
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($p.Port)/v1/models" -UseBasicParsing -TimeoutSec 15
    $j = $r.Content | ConvertFrom-Json
    $models = @($j.data).Count
    $ok = $true
  } catch { }

  if ($ok) {
    Write-Host "  ✅ $($p.Label) :$($p.Port)  正常，$models 个模型" -ForegroundColor Green
  } else {
    Write-Host "  ❌ $($p.Label) :$($p.Port)  起不来，请重跑一次或看该目录下的 proxy.log" -ForegroundColor Red
  }
}

Write-Host ''
Write-Host '  DSH 说明：DSH 每次启动都会从上游实时拉取目录，所以' -ForegroundColor DarkGray
Write-Host '  它本来就跟得上；本次同步的是插件里的「兜底表」' -ForegroundColor DarkGray
Write-Host '  （只在实时拉取失败时才用到）。重启 DSH 后生效。' -ForegroundColor DarkGray

Write-Host ''
Write-Host '  更新完成。' -ForegroundColor White
Write-Host ''
Read-Host '  按回车关闭窗口'
