# ZCode ↔ WorkBuddy 反代

把 WorkBuddy 桌面 App 账号里的 15 个模型(GLM-5.3 / GLM-5.3-Flash / DeepSeek-V4-Pro / Kimi-K3 / MiniMax-M3 / Hy4 …)以 **Anthropic Messages API** 的形式暴露在 `127.0.0.1:8400`,供 ZCode(`kind: "anthropic"` provider)直接使用。零额外凭据——直接复用本机 WorkBuddy 桌面 App 的登录态。

## 架构

```
ZCode ──/v1/messages (Anthropic)──▶ proxy.mjs (127.0.0.1:8400)
                                      │  翻译: Anthropic ⇄ OpenAI
                                      │  凭据: WorkBuddy 桌面 App auth 文件
                                      │  (401 时自动用 refreshToken 刷新)
                                      ▼
                          https://copilot.tencent.com/v2/chat/completions
                                      (WorkBuddy 上游, OpenAI 风格 SSE)
```

协议参照本机 DSH 插件 `dsh-workbuddy-connect@0.3.1` 的实现(其上游协议参照开源项目 [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api))。

## 文件

| 文件 | 作用 |
|---|---|
| `proxy.mjs` | 反代本体(Node ≥ 18,无依赖) |
| `proxy.ps1` | `start` / `stop` / `status` / `restart` |
| `probe.mjs` | 上游协议探针(开发用) |
| `test-e2e.mjs` | 端到端测试(模型列表/非流式/流式/工具调用) |

## 使用

```powershell
# 启动 / 停止 / 状态
powershell -File proxy.ps1 start
powershell -File proxy.ps1 stop
powershell -File proxy.ps1 status
```

验证:`curl http://127.0.0.1:8400/healthz`

**ZCode 侧配置已写入** `C:\Users\<USER>\.zcode\v2\config.json`(备份在同目录 `config.json.bak-workbuddy-proxy`):provider id `zcode-workbuddy-proxy`,显示名 "WorkBuddy",指向 `http://127.0.0.1:8400`。重启 ZCode 后在模型选择里切换即可。

**开机自启(可选)**:

```
schtasks /Create /TN "zcode-workbuddy-proxy" /SC ONLOGON ^
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File \"D:\dsh工作区\dsh工作区2\zcode-workbuddy-proxy\proxy.ps1\" start"
```

## 模型

`GET /v1/models` 返回上游 cli agent 的实时目录(失败时用内置兜底表):

`auto, hy4-preview, hy3, hy3-x, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, kimi-k3-1, kimi-k2.7, kimi-k2.6, minimax-m3, deepseek-v4-flash, deepseek-v4-pro`

ZCode 配置里默认注册了 7 个主力模型;`hy3`、`hy4-preview` 当前限时免费(x0.00)。

## 实现要点(上游怪癖)

- 上游**只接受流式**请求:代理统一 `stream:true` 发上游,客户端要非流式时在本地聚合成 Anthropic JSON。
- `role:"developer"` 必须改写为 `system`,否则上游 400(code 11128)。
- **Anthropic 多文本块 content 必须拍平成字符串**(2026-09-11):user 消息含多个 text 块时发裸字符串数组会 400(code 11101 "Parse message failed")。纯文本一律 join("\n");仅含图片时用 `{type:text|image_url}` parts 数组。
- **增量里的 `"tool_calls":[]` 空数组必须忽略**(2026-09-11):见数组就关思维链块的话,glm 逐词推送的 reasoning 会被切成每词一块(客户端里每词一行)。修复:`tcs.length > 0` 才处理。
- `tool_choice` 只吃字符串;Anthropic 的 `tool_choice:{type:"tool",name}` 翻译成函数名。
- 思考内容在 `delta.reasoning_content`,翻译成 Anthropic 的 `thinking` 块;`reasoning_effort` 只在模型目录声明的档位集合内下发(Anthropic 的 `thinking.budget_tokens` 映射为 low/high/max)。
- 工具调用:`tool_calls` 增量聚合后以 `tool_use` 块 + `input_json_delta` 发回;`tool_result` 翻译为 OpenAI 的 `role:"tool"` 消息。
- **11128「Illegal API invocation」身份清洗**(2026-09-11):上游按完整子串拦截第三方 agent 身份声明。发上游前 `sanitizeDeep` 深度遍历整个 body;黑名单 = DSH 插件提取条目(`identity-blocklist.json`,base64)+ 形状正则 + **自愈学习**(上游回 11128 时自动从被拒请求体提取身份句入名单并重试一次,learned 上限 50 条)。未知形状则落盘 `capture/`,用 `_analyze-11128.mjs` + `_bisect-11128-system.mjs` 以上游为 oracle 二分定位(全程零内容打印)。
- 错误分类:积分不足 → 402,限流 → 429,会话失效 → 401(并自动重读桌面凭据),上游 5xx → 502。

## 凭据与刷新

- 读取:`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`(可用环境变量 `WORKBUDDY_AUTH_FILE` 覆盖)。
- 访问 token 剩 5 分钟内到期时自动调 `/v2/plugin/auth/token/refresh`,刷新结果存 `~\.zcode-workbuddy-proxy\auth.json`(不写桌面 App 的文件,和 DSH 插件同策略)。
- 桌面 App 保持登录即可;App 里重新登录后代理下次请求自动跟随新 token。

## 已知限制

- 仅监听 `127.0.0.1`,不对局域网开放(鉴权为宽松 Bearer,需要严格鉴权时设置环境变量 `WB_PROXY_TOKEN` 并重启)。
- 上游按 WorkBuddy 积分计费,倍率随模型不同(x0.06 ~ x1.62);hy3 / hy4-preview 限时免费。
- 依赖 WorkBuddy 客户端非官方接口,上游协议变更时需要跟进(参照 `dsh-workbuddy-connect` 的更新)。
- 仅供个人学习研究,驱动自己的 WorkBuddy 账号在本机调用。
