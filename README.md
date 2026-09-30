# WorkBuddy Proxy

把 **WorkBuddy**（腾讯国内版）和 **WorkBuddy AI**（腾讯国际版，workbuddy.ai）桌面客户端里**已登录账号**的模型，以本地 OpenAI / Anthropic 兼容接口暴露出来，供 **Codex**、**ZCode** 等客户端直接调用。

**零额外凭据** —— 不注册、不配置 API Key，直接复用桌面 App 自己的登录态。

> ## ⚠️ 先读这一段
>
> 1. **本仓库不含 WorkBuddy 客户端本体。** WorkBuddy / WorkBuddy AI 是**腾讯的闭源商业软件**（`© Tencent Technology (Shenzhen) Company Limited`，安装包有有效 Authenticode 签名）。本仓库只是运行在**你自己机器上、用你自己账号**的一层本地协议转换代理。
> 2. **国际版（workbuddy.ai）的协议参数不是原创。** 它们移植自 MIT 开源项目 `dsh-workbuddy-connect`（`© 2026 Corrine Hu`）。**必须保留其版权声明** —— 见 [来源与归属](#-来源与归属----必读)。
> 3. **依赖非官方接口。** 上游一旦改协议，本仓库即失效，需要跟进。
> 4. **仅供个人学习研究**，用于驱动你自己的账号在本机调用。

---

## 解决什么问题

### 原始困境

你在 **WorkBuddy 桌面 App** 里有一个已登录、已充值（积分制）的账号，里面有十几个模型
（GLM-5.3 / DeepSeek-V4-Pro / Kimi-K3 / MiniMax-M3 / hy4 …）。但**它们锁在 WorkBuddy 自己的 GUI 里**：

- 你在 **Codex / ZCode** 里写代码，模型选择器里根本没有这些模型
- 想用就只能两个 App 之间来回复制粘贴
- 单独去申请 API Key 也不现实 —— 桌面端和 API 端是两套东西

就算你决定自己接一层，前面还横着四堵墙：

| 墙 | 具体情况 |
|---|---|
| **协议墙** | Codex CLI ≥ 0.15x 只认 `wire_api = "responses"`；ZCode 只认 Anthropic Messages；而上游只提供 `chat completions` —— 三方两两不通 |
| **凭据墙** | 桌面 App 的 access token 会过期，需要自动刷新；而且不能写坏 App 自己的凭据文件 |
| **怪癖墙** | 上游有一堆非标准行为，任何一条没处理就是 400（详见下文「上游怪癖」） |
| **双版本墙** | 国内版与国际版是**两套账号体系**：基址、凭据文件名、模型目录接口全不同 |

### 这个项目做了什么

一句话：**把你已经付费的 WorkBuddy 账号里的模型，接进你已经在用的 CLI 工作流，
并抹平协议差异与上游怪癖。**

| # | 解决的问题 | 怎么解的 |
|---|---|---|
| 1 | 客户端与上游**协议不通** | 在 `127.0.0.1` 起本地服务做双向翻译：Responses ⇄ chat completions（Codex 味）、Anthropic ⇄ OpenAI（ZCode 味），含 SSE 流式互转与非流式本地聚合 |
| 2 | 不想重新申请凭据 | **零配置复用桌面 App 登录态** —— 直接读它已登录的凭据文件 |
| 3 | token 会过期、还可能写坏 App | 到期前自动刷新，结果存独立目录（`~\.zcode-workbuddy-proxy\`），**不写回 App 的文件**；App 里切号后下一条请求自动跟随 |
| 4 | 上游怪癖导致必失败 | 逐条抹平：强制流式、`developer`→`system`、内容拍平、空 `tool_calls` 忽略、身份清洗、国际版不下发思维链参数 |
| 5 | 国内版 / 国际版两套 | **一套代码、两个变体**（`WB_VARIANT=cn\|ai`），region 由凭据里的 domain 自动判定 |
| 6 | 国际版出网被 fake-ip DNS 劫持 | 代码内兜底挂代理（mihomo 混合端口），启动器不必拼长串 env |
| 7 | 每次都要手动起 | 照搬 DSH 自身的隐藏窗口自启法（VBS + `HKCU\...\Run`）—— **无服务、无计划任务** |
| 8 | 上游会加新模型 | `tools/sync-model-catalog.mjs` 同步目录，拉不到时回落内置表 |
| 9 | 出问题不好查 | 400 时自动落盘请求体；一整套探针 / 二分 / 审计脚本（`dev/`）；错误分类（402 / 429 / 401 / 502） |

### 效果对比

| | 之前 | 之后 |
|---|---|---|
| 这些模型能用的地方 | 只有 WorkBuddy 的 GUI | Codex / ZCode 里直接选 |
| 切换成本 | 两个 App 之间复制粘贴 | 一个 provider 切过去 |
| 凭据 | 需要单独申请 API Key | 零配置，复用桌面端登录态 |
| 国际版 | 还得自己处理 DNS / 代理 | 自动兜底 |
| 开机 | 每次手动起 | 登录即有 |

---

## 这是什么

四个实例，两套代码（Codex 味 / ZCode 味）× 两个变体（国内版 / 国际版）：

| 实例 | 端口 | 变体 | 上游基址 | 凭据文件 |
|---|---|---|---|---|
| ZCode 国内版 | `8400` | `cn` | `https://copilot.tencent.com` | `workbuddy-desktop.info` |
| Codex 国内版 | `8401` | `cn` | `https://copilot.tencent.com` | `workbuddy-desktop.info` |
| ZCode 国际版 | `8402` | `ai` | `https://www.workbuddy.ai` | `workbuddy-desktop-ai.info` |
| Codex 国际版 | `8403` | `ai` | `https://www.workbuddy.ai` | `workbuddy-desktop-ai.info` |

两个客户端要求的线协议不同，所以需要两种翻译：

- **Codex 味**（`codex/`）：codex-cli ≥ 0.15x 只支持 `wire_api = "responses"`，上游只给 `chat completions`
  → 代理在 `127.0.0.1` 暴露 **OpenAI Responses API**，双向翻译请求与 SSE
- **ZCode 味**（`zcode/`）：ZCode 用 **Anthropic Messages API**
  → 代理暴露 `/v1/messages`，双向翻译 Anthropic ⇄ OpenAI

两者共享同一套上游契约知识、凭据处理、身份清洗与错误分类。

---

## ★ 来源与归属 —— 必读

这一节回答一个问题：**这个仓库里，哪些是别人做的，哪些是我做的。**

### 别人做的（第三方）

| 组件 | 作者 / 归属 | 许可 | 在本项目中的角色 |
|---|---|---|---|
| **WorkBuddy / WorkBuddy AI 客户端** | Tencent Technology (Shenzhen) Company Limited | 闭源商业软件 | **上游服务本体**。本项目只调用它，**不分发**其任何文件 |
| **`dsh-workbuddy-connect`** | [corrinehu](https://github.com/corrinehu/dsh-workbuddy-connect)（Corrine Hu） | **MIT** | **国际版协议参数的来源**。见下方逐项对照 |
| **`cc-switch`** | [farion1231](https://github.com/farion1231/cc-switch) | MIT | Codex 侧的 provider 切换器；`codex/install-ccswitch-provider*.mjs` 只写它的配置库，不包含其代码 |
| **`Sliverkiss/workbuddy2api`** | Sliverkiss | 未声明（**仓库现已 404**） | 早期上游协议参考（国内版）。本仓库**不含其任何代码** |
| Codex CLI / ZCode | OpenAI / Z.ai | 各自许可 | **客户端**，本项目的消费者 |

### 我做的（原创）

| 组件 | 位置 | 说明 |
|---|---|---|
| **反代本体（Codex 味）** | `codex/proxy.mjs`（约 1060 行） | OpenAI Responses ⇄ chat completions 双向翻译、SSE 互转、非流式本地聚合、凭据刷新、11128 清洗、错误分类。**零依赖**，只用 Node 内置模块 |
| **反代本体（ZCode 味）** | `zcode/proxy.mjs`（约 1120 行） | Anthropic Messages ⇄ OpenAI 双向翻译、`thinking` 块映射、`tool_use` / `tool_result` 往返、内容拍平。**零依赖** |
| 启动 / 停止脚本 | `codex/proxy.ps1`、`zcode/proxy.ps1` | start / stop / status / restart |
| 端到端测试 | `*/test-e2e.mjs`、`codex/test-responses.mjs`、`zcode/probe.mjs` | 模型列表 / 流式 / 非流式 / 工具调用 |
| 客户端接入脚本 | `codex/install-ccswitch-provider*.mjs` | 写入 cc-switch 的 provider 配置，`--remove` 可回滚 |
| 模型目录同步 | `tools/sync-model-catalog.mjs` | 从上游实时拉模型目录并落盘 |
| 开机自启 | `autostart/*.vbs` | 照搬 DSH 自身的隐藏窗口启动法（`wscript` + `HKCU\...\Run`），**无服务、无计划任务** |
| 健康看门狗 | `autostart/proxy-watchdog.mjs`、`autostart/check-ai-channel.mjs` | 端口探活、AI 通道检测 |
| 11128 修复工具链 | `tools/patch-workbuddy-sanitize.mjs`、`tools/verify-workbuddy-11128.mjs`、`docs/11128-修复清单.md` | 以上游为 oracle 的二分定位与验证 |
| 黑名单提取器 | `tools/extract-blocklist-for-zcode.mjs` | 从**本地已安装**的 `dsh-workbuddy-connect` 里提取身份条目（见下方说明） |
| 排障脚本 | `dev/codex/`、`dev/zcode/` | 约 40 个一次性探针 / 二分 / 审计脚本，保留供参考，**非运行必需** |

### 逐项对照：国际版参数是「移植」不是「原创」

开源插件 `dsh-workbuddy-connect` 自带完整的国际版实现。下表左右两列可直接对照 ——
**常量名、字符串、文件名完全一致**，说明这部分是移植而非独立逆向：

| 要素 | `dsh-workbuddy-connect`（MIT，Corrine Hu） | 本仓库 `codex/proxy.mjs` |
|---|---|---|
| 国际版基址 | `const GLOBAL_BASE = "https://www.workbuddy.ai"` | `const GLOBAL_BASE = "https://www.workbuddy.ai"` |
| 凭据文件名 | `desktopFilename: "workbuddy-desktop-ai.info"` | `AUTH_FILENAME = ... "workbuddy-desktop-ai.info"` |
| 凭据环境变量 | `env: "WORKBUDDY_AI_AUTH_FILE"` | `process.env.WORKBUDDY_AI_AUTH_FILE` |
| 目录缓存文件 | `catalogFilename: ".workbuddy-ai-catalog.json"` | `~/.dsh/.workbuddy-ai-catalog.json` |
| 区域判定 | `workbuddy.ai` → `"global"` | `workbuddy.ai` → `"global"` |
| 变体结构 | `WORKBUDDY_VARIANTS = [workbuddy(cn), workbuddy-ai(global)]` | `VARIANT = "cn" \| "ai"` |
| App 形状 UA | `appUserAgent(version)`（含国际版目录 UA 逻辑） | `CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2"` |

**边界怎么划：**

- **移植来的**：国际版**协议层** —— 基址、凭据文件位置、环境变量名、缓存文件名、区域判定、App 形状 UA、上游怪癖知识
- **我写的是外层**：HTTP 服务与路由、协议翻译（Responses / Anthropic ⇄ OpenAI）、SSE 双向互转、非流式聚合、token 到期自动刷新与重试、mihomo 代理兜底、11128 清洗与自愈学习、错误码分类、看门狗与自启

> 补充：`identity-blocklist.json`（从插件二进制里提取的身份条目）**刻意不入库**。
> 它可从你本地已安装的插件用 `tools/extract-blocklist-for-zcode.mjs` 自行生成；
> 缺失时代理会打印一行告警并继续跑，且会在收到 11128 时**自愈学习**重建。

### 三方许可义务

`dsh-workbuddy-connect` 是 MIT：复制了实质部分就必须保留版权声明与许可文本。
完整许可原文见 **[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)**。

---

## 架构与数据流

```
┌──────────────┐   /v1/responses (Responses)      ┌────────────────────┐
│  Codex CLI   │ ───────────────────────────────▶ │ codex/proxy.mjs    │
└──────────────┘                                  │  127.0.0.1:8401/cn │
                                                  │  127.0.0.1:8403/ai │
┌──────────────┐   /v1/messages (Anthropic)       ├────────────────────┤
│  ZCode       │ ───────────────────────────────▶ │ zcode/proxy.mjs    │
└──────────────┘                                  │  127.0.0.1:8400/cn │
                                                  │  127.0.0.1:8402/ai │
                                                  └─────────┬──────────┘
                       翻译成 OpenAI chat completions       │
                       读桌面 App 凭据 / 自动刷新 token      │
                       身份清洗 / 错误分类                    ▼
                                          ┌───────────────────────────────────┐
                                          │ cn: https://copilot.tencent.com   │
                                          │ ai: https://www.workbuddy.ai      │
                                          │     (OpenAI 风格 SSE)             │
                                          └───────────────────────────────────┘
```

**凭据**：读 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop[-ai].info`。
访问 token 剩 5 分钟内到期时自动调 `/v2/plugin/auth/token/refresh`，
刷新结果存 `~\.zcode-workbuddy-proxy\auth.json` —— **不写回桌面 App 的文件**。
凭据文件 mtime 变化时下一条请求自动跟随（App 里切号即生效）。

---

## 快速开始

**要求**：Windows + Node.js ≥ 18。**零 npm 依赖**，不需要 `npm install`。

```powershell
# 启动 / 停止 / 状态
powershell -File codex\proxy.ps1 start
powershell -File codex\proxy.ps1 status

# 国际版：加 --ai 或设 WB_VARIANT=ai
powershell -File codex\proxy.ps1 start   # 先设 $env:WB_VARIANT='ai'

# 健康检查
curl.exe -s http://127.0.0.1:8401/healthz
```

**客户端接入**

- **ZCode**：provider `kind: "anthropic"` → `http://127.0.0.1:8400`（国际版 `8402`）
- **Codex / cc-switch**：跑 `node codex\install-ccswitch-provider.mjs`（国际版 `-ai`，`--remove` 回滚）

**开机自启**：见 [`autostart/README.md`](autostart/README.md)。
**模型目录同步**：见 [`tools/README.md`](tools/README.md)。

> ⚠️ **不要在 DSH 会话里手动起代理**：会拿到受限令牌，读凭据时报
> `EPERM: operation not permitted, open '...workbuddy-desktop.info'`，
> 症状是 `/v1/models` 能通、一发消息就 500。用 `autostart/` 里的 VBS 起就没这个问题。

---

## 上游怪癖（踩坑记录）

这些都是实测出来的，写在这里省得下一个人再踩：

- **只接受流式**：统一 `stream:true` 发上游，客户端要非流式时本地聚合
- **`role:"developer"` 必须改写成 `system`**，否则 400 / `code 11128`
- **`tool_choice` 只吃字符串**
- **`reasoning_effort` 只在模型目录声明的档位集合内下发**
- **Anthropic 多文本块 content 必须拍平成字符串**，否则 400 / `code 11101`
- **增量里的 `"tool_calls":[]` 空数组必须忽略**，否则思维链会被逐词切块
- **11128「Illegal API invocation」身份清洗**：上游按完整子串拦截第三方 agent 身份声明。
  发上游前深度遍历 body 做替换（黑名单 + 形状正则 + 自愈学习）
- **国际版不发思维链参数**：上游要求「上一轮完整 `reasoning_content` 回传」，
  Codex/ZCode 协议满足不了 → 长对话必报 `400 code 11155 reasoning_content_missing`。
  故 `ai` 变体一律不下发 `reasoning_effort`（模型以非思考模式运行，多轮稳定）
- **国际版 `messages[0]` 必须是 system**，代理缺则自动注入
- **国际版出网要走代理**：`workbuddy.ai` 被 fake-ip DNS 劫持，直连 fake-ip 会被拒
- **错误分类**：积分不足 → 402，限流 → 429，会话失效 → 401（自动重读凭据），上游 5xx → 502

---

## 已知限制

- 仅监听 `127.0.0.1`，不对局域网开放；鉴权是宽松 Bearer，需要严格鉴权时设 `WB_PROXY_TOKEN`
- 代理崩了**不会自动重启**（刻意保持简单），`autostart/proxy-watchdog.mjs` 可自行挂上
- 上游按积分计费，倍率随模型不同（x0.06 ~ x1.62）
- **依赖非官方接口**，上游协议变更即失效
- 脚本里的绝对路径是本机路径，换机器需自行调整

## 法律与合规提示

- WorkBuddy / WorkBuddy AI 是腾讯的闭源商业软件，受其**服务条款**约束。
  本项目通过**非官方接口**访问，可能违反其 ToS；使用前请自行评估。
- 请只用于**你自己账号**的本机调用，不要用于批量、转售或规避计费。
- 本项目**不绕过付费**：所有调用仍然消耗你自己账号的积分。
- 作者不对因使用本项目导致的账号封禁、积分损失或任何其他后果负责。

## License

本仓库**原创部分**：MIT —— 见 [LICENSE](LICENSE)。
**第三方部分**的许可与归属：见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

---

## English Provenance Summary

**What this is:** a local, zero-dependency protocol-translation proxy that exposes the models of an
already-signed-in **WorkBuddy** (Tencent, CN) or **WorkBuddy AI** (Tencent, international) desktop
client as OpenAI-Responses / Anthropic-Messages compatible endpoints for Codex and ZCode.

**Not mine:**

- **WorkBuddy / WorkBuddy AI desktop clients** — proprietary commercial software by
  *Tencent Technology (Shenzhen) Company Limited*. Not redistributed here.
- **`dsh-workbuddy-connect`** by [corrinehu](https://github.com/corrinehu/dsh-workbuddy-connect) —
  **MIT, © 2026 Corrine Hu**. The **international-variant protocol constants** (base URL, credential
  filename, env var, catalog filename, region detection, app-shaped User-Agent) are **ported from this
  project**, not independently reverse-engineered. Its MIT notice is reproduced in
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) as required.
- **`cc-switch`** by farion1231 (MIT) — used as a provider-switcher; no code included.
- **`Sliverkiss/workbuddy2api`** — an early protocol reference for the CN variant. The repository is
  now 404. **No code from it is included here.**

**Mine:** the proxy itself (`proxy.mjs` in both flavours), the Responses/Anthropic ⇄ OpenAI translation,
SSE conversion, local non-stream aggregation, credential refresh, identity sanitisation, error
classification, launcher/test/autostart/watchdog tooling, and all diagnostic scripts.
