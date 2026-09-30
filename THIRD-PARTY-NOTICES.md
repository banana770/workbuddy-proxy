# Third-Party Notices / 第三方许可与归属

本文件列出 WorkBuddy Proxy 依赖、引用或移植的第三方成果。
**这不是可选文件** —— 其中 `dsh-workbuddy-connect` 是 MIT 许可，本仓库移植了它的实质部分，
按许可要求**必须**保留下列版权声明与许可原文。

---

## 1. `dsh-workbuddy-connect` — ★ 必须保留

- **项目**：<https://github.com/corrinehu/dsh-workbuddy-connect>
- **作者**：Corrine Hu（npm: `corrinehu`）
- **许可**：MIT License
- **用途**：**国际版（workbuddy.ai）协议参数的来源**

本仓库从中**移植**了国际版协议层，包括但不限于：

| 移植内容 | 本仓库位置 |
|---|---|
| 国际版基址 `https://www.workbuddy.ai` | `codex/proxy.mjs`、`zcode/proxy.mjs` |
| 凭据文件名 `workbuddy-desktop-ai.info` | 同上 |
| 凭据环境变量 `WORKBUDDY_AI_AUTH_FILE` | 同上 |
| 目录缓存文件名 `.workbuddy-ai-catalog.json` | 同上 |
| 区域判定规则（`workbuddy.ai` → `global`） | 同上 |
| App 形状 User-Agent 构造思路 | 同上 |
| 上游怪癖知识（流式限制、身份拦截等） | 两个 `proxy.mjs` 与 `docs/` |

此外，`tools/extract-blocklist-for-zcode.mjs` 的功能是**从本地已安装的**
`dsh-workbuddy-connect` 中提取身份条目。该脚本本身为原创，但提取结果来源于上述项目。
**提取产物 `identity-blocklist.json` 刻意未包含在本仓库中。**

### MIT License — 原文

```
MIT License

Copyright (c) 2026 Corrine Hu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. `cc-switch`

- **项目**：<https://github.com/farion1231/cc-switch>
- **作者**：farion1231
- **许可**：MIT License
- **用途**：Codex 侧的 provider 切换器（外部工具）

本仓库**不包含** cc-switch 的任何代码。
`codex/install-ccswitch-provider.mjs` 与 `codex/install-ccswitch-provider-ai.mjs`
仅向 cc-switch 的配置库写入一条 provider 记录，属于**配置文件互操作**。

---

## 3. `Sliverkiss/workbuddy2api`

- **项目**：`https://github.com/Sliverkiss/workbuddy2api`
- **状态**：**该仓库当前已不可访问（HTTP 404）**，许可未知
- **用途**：国内版上游协议的早期参考

本仓库**不包含**该项目任何代码。仅在此说明历史上曾参考过其公开的协议描述。

---

## 4. WorkBuddy / WorkBuddy AI 桌面客户端

- **权利方**：Tencent Technology (Shenzhen) Company Limited
- **许可**：闭源商业软件（`Copyright © 2026 Tencent Technology (Shenzhen) Company Limited`）
- **用途**：**上游服务本体**，本项目通过其非官方接口调用

本仓库**不分发**其任何文件、二进制、凭据或数据。
用户需自行安装并登录该客户端。

**注意**：通过非官方接口访问可能违反其服务条款，详见主 README 的「法律与合规提示」。

---

## 5. 运行环境

- **Node.js** —— 本项目**零 npm 运行时依赖**，仅使用 Node 内置模块（`node:http`、`node:fs`、`node:crypto` 等）

---

# 总结 / Summary

| 类别 | 是否包含在本仓库 | 是否需要保留声明 |
|---|---|---|
| 本仓库原创代码 | ✅ 是 | © 2026 banana770, MIT（见 `LICENSE`） |
| `dsh-workbuddy-connect` 移植部分 | ⚠️ 仅移植，不含其文件 | ✅ **必须**（MIT 要求） |
| `cc-switch` | ❌ 否 | ⚠️ 建议（致谢） |
| `Sliverkiss/workbuddy2api` | ❌ 否 | ⚠️ 建议（致谢） |
| WorkBuddy / WorkBuddy AI 客户端 | ❌ 否 | ❌ 不适用（未使用其代码） |
