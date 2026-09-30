# WorkBuddy 反代自启

让 `:8400`（ZCode）和 `:8401`（Codex）两个反代跟 **DSH 一样**：
开机登录后自动隐藏启动，不用管。

---

## 就是这一套路，跟 DSH 完全一样

你机器上 DSH 是这么自启的（注册表里原本就有）：

```
DSH Web (qq-bridge) = wscript.exe "...\start-dsh-web-hidden.vbs"
```

本目录照抄这个做法，注册表里现在多了两条：

```
WorkBuddy Proxy (ZCode) = wscript.exe "D:\dsh工作区\dsh工作区2\workbuddy-proxy-autostart\start-zcode-proxy.vbs"
WorkBuddy Proxy (Codex) = wscript.exe "D:\dsh工作区\dsh工作区2\workbuddy-proxy-autostart\start-codex-proxy.vbs"
```

位置：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

**没有计划任务、没有守护进程、没有服务。** 就两个 VBS（各 20 行）+ 两条注册表项。

---

## 文件

| 文件 | 作用 |
|---|---|
| `start-zcode-proxy.vbs` | 隐藏窗口启动 `..\zcode-workbuddy-proxy\proxy.mjs`（8400） |
| `start-codex-proxy.vbs` | 隐藏窗口启动 `..\codex-workbuddy-proxy\proxy.mjs`（8401） |

VBS 里用的是 `sh.Run "cmd /c node proxy.mjs", 0, False` —— `0` 表示隐藏窗口，`False` 表示不等待。

---

## 日常

**什么都不用做。** 开机登录后自动就有。

想手动确认 / 重启：

```powershell
# 看端口在不在
netstat -ano | findstr ":8400 :8401"

# 健康检查
curl.exe -s http://127.0.0.1:8400/healthz
curl.exe -s http://127.0.0.1:8401/healthz

# 手动重启某个
#   先杀掉该端口的进程，再跑对应的 vbs
wscript.exe "D:\dsh工作区\dsh工作区2\workbuddy-proxy-autostart\start-codex-proxy.vbs"
```

---

## 卸载

```powershell
$k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Remove-ItemProperty $k -Name 'WorkBuddy Proxy (ZCode)' -ErrorAction SilentlyContinue
Remove-ItemProperty $k -Name 'WorkBuddy Proxy (Codex)' -ErrorAction SilentlyContinue
```

然后删掉本目录即可。不影响两个代理本身（仍可手动 `proxy.ps1 start`）。

---

## 模型目录更新（另一件事）

自启只管「进程活着」。上游加了新模型后要单独同步：

```powershell
node "D:\dsh工作区\dsh工作区2\workbuddy-model-sync\sync-model-catalog.mjs"
```

跑完重启两个代理：

```powershell
# 杀掉 8400/8401 上的进程后
wscript.exe "D:\dsh工作区\dsh工作区2\workbuddy-proxy-autostart\start-zcode-proxy.vbs"
wscript.exe "D:\dsh工作区\dsh工作区2\workbuddy-proxy-autostart\start-codex-proxy.vbs"
```

---

## 排查备忘

**判断端口占用别用 `Get-NetTCPConnection`** —— 本机实测经常返回空，用 `netstat -ano | findstr :8401`。

**不要在 DSH 会话里手动起代理**：会拿到受限令牌，读 WorkBuddy 凭据时报
`EPERM: operation not permitted, open '...\workbuddy-desktop.info'`，
症状是 `/v1/models` 能通、一发消息就 500。用上面的 VBS 起就没这个问题。

**代理崩了不会自动重启** —— 这是刻意保持简单的代价，跟 DSH 行为一致（DSH 崩了也要你手动重开）。如果哪天觉得需要自愈，再说。

---

## 国际版（WorkBuddy AI / workbuddy.ai）—— 2026-09-13 新增

一套代码、两个变体：`proxy.mjs` 用环境变量 `WB_VARIANT` 切换，**region 由凭据里的 domain 自动判定**。

| 实例 | 端口 | 变体 | 凭据文件 |
|---|---|---|---|
| ZCode 国内版 | 8400 | `cn`（默认） | `workbuddy-desktop.info` |
| Codex 国内版 | 8401 | `cn`（默认） | 同上 |
| **ZCode 国际版** | **8402** | **`ai`** | `workbuddy-desktop-ai.info` |
| **Codex 国际版** | **8403** | **`ai`** | 同上 |

自启：`start-{zcode,codex}-proxy.vbs`（HKCU Run，国内版）+ `start-{zcode,codex}-proxy-ai.vbs`
（已放 `shell:startup` 启动文件夹，国际版）。

国际版与国内版的三处差异（其余全同）：
1. 基址 `https://www.workbuddy.ai`（`originReferer`/`chatBase` 自动跟随）；
2. 凭据文件为 `workbuddy-desktop-ai.info`；
3. **`messages[0]` 必须是 system** —— 代理缺则自动注入 `You are a helpful assistant.`。

模型目录：国内版走 `/console/enterprises/personal/models`；国际版读 DSH 插件缓存的
`~/.dsh/.workbuddy-ai-catalog.json`（App 界面接口那套），失败回落到内置 20 个模型。

客户端接入：
- **ZCode**：provider `zcode-workbuddy-ai-proxy`（显示名 "WorkBuddy AI"）→ `http://127.0.0.1:8402`
- **Codex / cc-switch**：provider `codex-workbuddy-ai-proxy`（"WorkBuddy AI"）→ `http://127.0.0.1:8403/v1`
  （写入脚本 `install-ccswitch-provider-ai.mjs`，`--remove` 可回滚）

### 2026-09-14 补充:国际版不发思维链参数

WorkBuddy 国际版网关的思维链契约要求「上一轮完整 reasoning_content 回传」,
Codex/ZCode 协议无法满足 → 长对话必报 `400 code 11155 reasoning_content_missing`。
故 **AI 变体(8402/8403)一律不向网关发送 `reasoning_effort`**(模型以非思考模式运行,
多轮稳定)。国内版(8400/8401)思维链不受影响。

另外:`resolveCredential` 会检查凭据文件 mtime,App 里切号后**下一条请求自动跟随新号**;
读凭据若恰逢 App 重写文件,自动重试 3 次不会崩进程。

排障工具(各反代目录):上游 400 时请求体自动落盘 `capture/400-<ts>.json`;
`_analyze-400.mjs` 看结构、`_replay-variants.mjs` 做变体重放。
