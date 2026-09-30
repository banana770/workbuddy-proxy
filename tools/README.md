# WorkBuddy 模型列表同步

上游（WorkBuddy）加了下架模型后，把新列表同步到 **DSH / ZCode / Codex** 三处。

**日常用法：双击桌面上的「更新 WorkBuddy 模型列表」快捷方式。**

---

## 为什么需要这个

上游的模型列表会变，但下游三处的目录大多是**静态写死**的，不会自己跟着更新。
于是出现「WorkBuddy 里明明有 deepseek-v4.1-flash，Codex/zcode 里却看不到」。

一共**五处**静态表：

| # | 位置 | 谁读它 |
|---|---|---|
| 1 | `codex-workbuddy-proxy/proxy.mjs` 的 `FALLBACK_MODELS` | Codex 代理的兜底 |
| 2 | `zcode-workbuddy-proxy/proxy.mjs` 的 `FALLBACK_MODELS` | ZCode 代理的兜底 |
| 3 | **cc-switch 里 codex provider 的 `modelCatalog`** | **Codex 读的就是它** |
| 4 | **`~/.zcode/v2/config.json` 的 `provider['zcode-workbuddy-proxy'].models`** | **ZCode 读的就是它** |
| 5 | `dsh-workbuddy-connect` 插件的 `FALLBACK_WORKBUDDY_MODELS` | DSH 的兜底 |

> 第 3、4 项是**纯静态**的，永远不会自己更新 —— 这才是「看不到新模型」的主因。
> 两个代理的 `/v1/models` 其实是**实时拉取**的（拉失败才用兜底表）。
> DSH 也是每次启动实时拉取，所以它本来就基本跟得上；第 5 项更新的是它的兜底表。

---

## 用法

### 一键（推荐）

双击桌面 **「更新 WorkBuddy 模型列表」**。它会：

1. 从上游实时拉取权威目录
2. 同步上面五处（每处写前自动备份）
3. 重启两个反代进程，让新列表生效
4. 显示结果

窗口会停住让你看结果，看完按回车关掉。

### 命令行

```powershell
cd "D:\dsh工作区\dsh工作区2\workbuddy-model-sync"

# 预览（不写任何文件）
node sync-model-catalog.mjs --dry-run

# 应用
node sync-model-catalog.mjs

# 只更新某一处
node sync-model-catalog.mjs --only codex|zcode|ccswitch|zcode-config|dsh
```

---

## 特性

- **幂等**：内容没变就不写盘、不产生备份。重复跑安全。
- **自动备份**：改动前备份为 `*.bak-modelsync-<时间戳>`。
- **自动校验**：改完 `.mjs` 会跑 `node --check`，语法不过自动回滚。
- **自动降级**：若上游 cli agent 没挂任何模型，直接中止，绝不清空好的配置。
- **默认模型保护**：若 cc-switch 里原来的默认模型被上游下架，自动换成还在的。

---

## 文件

| 文件 | 作用 |
|---|---|
| `update-all.ps1` | 桌面快捷方式指向的入口：同步 + 重启代理 + 显示结果 |
| `sync-model-catalog.mjs` | 同步本体，也可单独用 |

---

## 注意

- 需要 **WorkBuddy 桌面 App 处于登录状态**（凭据从 App 读）。
- 改完**两个代理需要重启**才生效 —— `update-all.ps1` 已经自动做了。
- 改完 **DSH 需要重启**才生效（插件是启动时加载的）。脚本不会自动重启 DSH，免得打断你正在进行的会话。
- 插件升级会覆盖第 5 项，升级后重跑一次即可。

---

## 出问题时

看窗口里的输出。常见情况：

| 现象 | 原因 |
|---|---|
| `找不到 WorkBuddy 凭据文件` | 桌面 App 没登录 |
| `上游 HTTP 401/403` | 登录过期，打开桌面 App 重新登录 |
| 某个代理 `起不来` | 看对应目录下的 `proxy.log` / `proxy.log.err` |
| 端口被占报 `EADDRINUSE` | 先 `netstat -ano \| findstr :8401` 找出并结束旧进程 |

回滚某一处：把它同目录的 `*.bak-modelsync-<时间戳>` 改回原名即可。
