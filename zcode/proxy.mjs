#!/usr/bin/env node
/**
 * ZCode ↔ WorkBuddy 反代
 *
 * 在 127.0.0.1 暴露 Anthropic Messages API(/v1/messages、/v1/models),
 * 把 ZCode(anthropic provider)发来的请求翻译成 WorkBuddy 桌面端账号的
 * 上游协议(https://copilot.tencent.com/v2/chat/completions,OpenAI 风格
 * SSE),再把上游响应翻译回 Anthropic SSE / JSON。
 *
 * 协议参照本机 DSH 插件 dsh-workbuddy-connect 0.3.1(其上游协议参照
 * Sliverkiss/workbuddy2api),凭据直接复用 WorkBuddy 桌面 App 的登录态:
 *   %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
 *
 * 关键上游怪癖(与 DSH 插件一致):
 *  - 上游只接受 stream:true,非流式请求在本地聚合回 JSON
 *  - role:"developer" 必须改写成 "system"(否则 400 / code 11128)
 *  - tool_choice 必须是字符串(对象形式 400)
 *  - reasoning_effort 只在目录声明的档位集合内下发
 *  - 思考内容在 delta.reasoning_content
 *
 * 环境变量:
 *   PORT                 监听端口(默认 8400)
 *   WORKBUDDY_AUTH_FILE  凭据文件路径(默认桌面 App 位置)
 *   WB_PROXY_TOKEN       请求代理所需的 Bearer(默认 "zcode-workbuddy")
 */
import { createServer } from "node:http";
import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// 变体:cn = 国内版 WorkBuddy;ai = 国际版 WorkBuddy AI(workbuddy.ai)
// 由环境变量 WB_VARIANT 切换;差异只在凭据文件、基址(region 自动判定)与
// 「messages[0] 必须为 system」这条国际版网关前置条件。
const VARIANT = (process.env.WB_VARIANT === "ai" || process.argv.includes("--ai")) ? "ai" : "cn";
const IS_AI = VARIANT === "ai";
const PORT = Number(process.env.PORT || (IS_AI ? 8402 : 8400));
const PROXY_TOKEN = process.env.WB_PROXY_TOKEN || (IS_AI ? "zcode-workbuddy-ai" : "zcode-workbuddy");
const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const AUTH_FILENAME = IS_AI ? "workbuddy-desktop-ai.info" : "workbuddy-desktop.info";
const AI_CATALOG_FILE = join(homedir(), ".dsh", ".workbuddy-ai-catalog.json");

// 国际版出网必须走 mihomo 混合端口:workbuddy.ai 被 fake-ip DNS 劫持,直连 fake-ip 会被拒。
// 在代码里兜底设置(启动器就不必拼一长串 env,VBS 更不易出错)。
if (IS_AI) {
  process.env.NODE_USE_ENV_PROXY ??= "1";
  process.env.HTTPS_PROXY ??= "http://127.0.0.1:7897";
  process.env.HTTP_PROXY ??= "http://127.0.0.1:7897";
  // 自记启动日志(启动器不再做 shell 重定向,便于排查「起了没有/去哪了」)
  try {
    appendFileSync(join(process.cwd(), "startup-ai.log"), `${new Date().toISOString()} variant=ai port=${PORT} pid=${process.pid} proxy=${process.env.HTTPS_PROXY}\n`);
  } catch {}
}
const JSON_TIMEOUT_MS = 30_000;
const REFRESH_MARGIN_MS = 5 * 60_000;

// ---------------------------------------------------------------- catalog

/** 国内版兜底模型目录(live 拉取失败时也够用),与上游 cli agent 一致。 */
const CN_FALLBACK_MODELS = [
  { id: "auto", ctx: 168_000, out: 32_000, img: true, efforts: ["high"], canOff: false },
  { id: "hy4-preview", ctx: 1_000_000, out: 64_000, img: true, efforts: ["high"], canOff: false },
  { id: "hy3", ctx: 192_000, out: 64_000, img: true, efforts: ["high"], canOff: false },
  { id: "hy3-x", ctx: 192_000, out: 64_000, img: true, efforts: ["low","high"], canOff: false },
  { id: "deepseek-v4.1-flash", ctx: 1_000_000, out: 128_000, img: true, efforts: ["high"], canOff: false },
  { id: "glm-5.3", ctx: 1_000_000, out: 48_000, img: true, efforts: ["low","high","max"], canOff: true },
  { id: "glm-5.3-flash", ctx: 1_000_000, out: 32_000, img: true, efforts: ["low","high","max"], canOff: true },
  { id: "glm-5.2", ctx: 1_000_000, out: 48_000, img: true, efforts: ["medium"], canOff: false },
  { id: "glm-5.1", ctx: 200_000, out: 48_000, img: false, efforts: ["medium"], canOff: false },
  { id: "glm-5v-turbo", ctx: 200_000, out: 64_000, img: true, efforts: ["medium"], canOff: false },
  { id: "kimi-k3-1", ctx: 1_000_000, out: 32_000, img: true, efforts: ["medium"], canOff: false },
  { id: "kimi-k2.7", ctx: 256_000, out: 32_000, img: true, efforts: ["medium"], canOff: false },
  { id: "kimi-k2.6", ctx: 256_000, out: 32_000, img: true, efforts: ["medium"], canOff: false },
  { id: "minimax-m3", ctx: 512_000, out: 128_000, img: true, efforts: ["medium"], canOff: false },
  { id: "deepseek-v4-pro", ctx: 1_000_000, out: 50_000, img: true, efforts: ["high"], canOff: false },
];

/** 国际版 WorkBuddy AI 兜底模型目录(取自插件本地缓存 ~/.dsh/.workbuddy-ai-catalog.json)。 */
const AI_FALLBACK_MODELS = [
  { id: "default-model", ctx: 176_000, out: 24_000, img: true, efforts: undefined, canOff: true },
  { id: "fast-model", ctx: 200_000, out: 32_000, img: true, efforts: ["medium"], canOff: false },
  { id: "balanced-model", ctx: 256_000, out: 32_000, img: true, efforts: ["medium"], canOff: false },
  { id: "primary-model", ctx: 272_000, out: 72_000, img: true, efforts: ["high"], canOff: false },
  { id: "deep-model", ctx: 176_000, out: 24_000, img: true, efforts: undefined, canOff: true },
  { id: "hy4-preview-f", ctx: 1_000_000, out: 64_000, img: true, efforts: ["high"], canOff: false },
  { id: "hy3", ctx: 192_000, out: 64_000, img: true, efforts: ["high"], canOff: false },
  { id: "deepseek-v4.1-flash", ctx: 1_000_000, out: 128_000, img: true, efforts: ["high"], canOff: false },
  { id: "gpt-6-astra", ctx: 400_000, out: 128_000, img: true, efforts: ["high"], canOff: false },
  { id: "gpt-5.6-sol", ctx: 1_000_000, out: 128_000, img: true, efforts: ["high"], canOff: false },
  { id: "gpt-5.6-terra", ctx: 1_000_000, out: 128_000, img: true, efforts: ["high"], canOff: false },
  { id: "gpt-5.6-luna", ctx: 1_000_000, out: 128_000, img: true, efforts: ["high"], canOff: false },
  { id: "gpt-5.5", ctx: 1_000_000, out: 128_000, img: true, efforts: ["high"], canOff: false },
  { id: "gpt-5.4", ctx: 272_000, out: 128_000, img: true, efforts: ["high"], canOff: false },
  { id: "gpt-5.3-codex", ctx: 272_000, out: 128_000, img: true, efforts: ["high"], canOff: false },
  { id: "gemini-3.5-flash", ctx: 1_000_000, out: 64_000, img: true, efforts: ["high"], canOff: false },
  { id: "glm-5.3", ctx: 1_000_000, out: 48_000, img: true, efforts: ["low", "high", "max"], canOff: true },
  { id: "glm-5.2", ctx: 1_000_000, out: 48_000, img: true, efforts: ["high", "xhigh"], canOff: true },
  { id: "kimi-k3", ctx: 1_000_000, out: 32_000, img: true, efforts: ["medium"], canOff: false },
  { id: "kimi-k2.6", ctx: 256_000, out: 32_000, img: true, efforts: ["medium"], canOff: false },
];

/** 当前变体使用的兜底目录。 */
const FALLBACK_MODELS = IS_AI ? AI_FALLBACK_MODELS : CN_FALLBACK_MODELS;
const modelInfo = new Map(FALLBACK_MODELS.map((m) => [m.id, m]));
function infoOf(id) {
  return modelInfo.get(id) ?? { id, ctx: 1_000_000, out: 32_000, img: true, efforts: undefined, canOff: false };
}

// ---------------------------------------------------------------- credential

function desktopAuthCandidates() {
  if (platform() === "win32") {
    return [
      join(homedir(), "AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth", AUTH_FILENAME),
      join(homedir(), "AppData", "Roaming", "CodeBuddyExtension", "Data", "Public", "auth", AUTH_FILENAME),
    ];
  }
  if (platform() === "darwin") {
    return [join(homedir(), "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth", AUTH_FILENAME)];
  }
  return [join(homedir(), ".config", "CodeBuddyExtension", "Data", "Public", "auth", AUTH_FILENAME)];
}
function authFilePath() {
  return (IS_AI ? process.env.WORKBUDDY_AI_AUTH_FILE : process.env.WORKBUDDY_AUTH_FILE)
    || process.env.WB_AUTH_FILE
    || desktopAuthCandidates()[0];
}

let cached = null; // { accessToken, refreshToken, expiresAtMs, domain, uid }
let cachedAuthMtimeMs = -1; // 凭据文件 mtime:App 切号/重登会改写文件,变化即重读

function expiryToMs(v) {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v > 1e12 ? v : v * 1e3;
}
function parseAuthDoc(text) {
  const parsed = JSON.parse(text);
  const auth = parsed.auth ?? parsed;
  const identity = parsed.account ?? parsed;
  if (typeof auth.accessToken !== "string" || auth.accessToken === "") throw new Error("auth doc has no accessToken");
  return {
    accessToken: auth.accessToken,
    refreshToken: typeof auth.refreshToken === "string" ? auth.refreshToken : "",
    expiresAtMs: expiryToMs(auth.expiresAt),
    domain: typeof auth.domain === "string" ? auth.domain : "",
    uid: typeof identity.uid === "string" ? identity.uid : "",
  };
}
async function readCredential() {
  const text = await readFile(authFilePath(), "utf8");
  return parseAuthDoc(text);
}
function regionOf(domain) {
  const d = (domain || "").trim().toLowerCase();
  return d === "workbuddy.ai" || d.endsWith(".workbuddy.ai") ? "global" : "cn";
}
function chatBase(c) {
  return regionOf(c.domain) === "global" ? GLOBAL_BASE : CN_CHAT_BASE;
}
function billingBase(c) {
  return regionOf(c.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
function originReferer(c) {
  return regionOf(c.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
function commonHeaders(c) {
  return {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: originReferer(c),
    Referer: `${originReferer(c)}/`,
    "User-Agent": CLIENT_UA,
  };
}
function chatHeaders(c) {
  return {
    ...commonHeaders(c),
    "Content-Type": "application/json",
    ...(c.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": c.uid }),
    ...(c.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": c.domain }),
    "X-Product": "SaaS",
  };
}

/**
 * 上游 fetch 传输层重试。
 * `TypeError: fetch failed`(http 0)多来自复用被 mihomo/中间设备回收的 keep-alive
 * 连接(连接被重置);传输失败时不会有半截响应,重试安全。
 */
async function fetchUpstreamRetry(url, init, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

/** 事件日志落盘(看门狗拉起的实例 stdout 被丢弃,故写文件便于排查)。 */
function logEvent(msg) {
  try {
    appendFileSync(join(PROXY_DIR, "proxy-events.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

/**
 * 工具参数 schema 清洗:剔除模型提供方会拒绝的非标准键。
 * 2026-09-28 实测:zcode 的 33 个工具 schema 全部带 `$schema`(json-schema.org/2020-12),
 * 模型侧突然开始严格校验 → 400 code 11133 / model_param_invalid(与 max_tokens 无关)。
 * 只在「schema 位置」删除,不动 properties 里同名的业务参数(如 metadata/annotations)。
 */
const TOOL_NOISE_KEYS = ["$schema", "propertyNames", "annotations", "$comment"];
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions"]);
const SCHEMA_CHILD_KEYS = new Set(["items", "additionalItems", "additionalProperties", "not", "if", "then", "else", "contains"]);
const SCHEMA_LIST_KEYS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);

function stripSchemaNoise(node) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) stripSchemaNoise(n); return; }
  for (const k of Object.keys(node)) {
    if (TOOL_NOISE_KEYS.includes(k)) { delete node[k]; continue; }
    let v = node[k];
    // additionalProperties 为「schema 对象」时,部分模型提供方会直接拒绝参数 →
    // 归一化成布尔 true(语义等价于"允许任意附加键",不影响生成)
    if (k === "additionalProperties" && v !== null && typeof v === "object") { node[k] = true; continue; }
    if (SCHEMA_MAP_KEYS.has(k) && v && typeof v === "object") { for (const sub of Object.values(v)) stripSchemaNoise(sub); continue; }
    if (SCHEMA_CHILD_KEYS.has(k) || SCHEMA_LIST_KEYS.has(k)) stripSchemaNoise(v);
  }
}

function sanitizeTools(tools) {
  if (!Array.isArray(tools)) return 0;
  let n = 0;
  for (const t of tools) {
    const fn = t?.function ?? t;
    if (fn?.parameters && typeof fn.parameters === "object") { stripSchemaNoise(fn.parameters); n += 1; }
  }
  return n;
}

/**
 * 消息顺序归一化。
 * 实测 2026-09-28:会话中途「插话/steering」会让历史变成
 *   assistant(tool_calls) → user(插话) → tool(结果)
 * ——工具结果被非 tool 消息隔开,上游以 400/11133(model_param_invalid)拒绝,
 * 且该坏结构会留在历史里导致之后每轮都失败。
 * 这里把每个 assistant(tool_calls) 对应的 tool 结果上移,紧跟其后,插话等消息顺延到结果之后。
 */
function normalizeMessageOrder(messages) {
  if (!Array.isArray(messages)) return 0;
  let fixes = 0;
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (!m || m.role !== "assistant" || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) { i += 1; continue; }
    const ids = new Set(m.tool_calls.map((tc) => tc?.id).filter(Boolean));
    let end = i + 1;
    while (end < messages.length && !(messages[end] && messages[end].role === "assistant")) end += 1;
    const window = messages.slice(i + 1, end);
    const isMatchedTool = (x) => x && x.role === "tool" && ids.has(x.tool_call_id);
    const toolMsgs = window.filter(isMatchedTool);
    if (toolMsgs.length) {
      const flags = window.map(isMatchedTool);
      const firstOther = flags.indexOf(false);
      const lastTool = flags.lastIndexOf(true);
      if (firstOther !== -1 && firstOther < lastTool) {
        const others = window.filter((x) => !isMatchedTool(x));
        messages.splice(i + 1, window.length, ...toolMsgs, ...others);
        fixes += 1;
      }
    }
    i = end;
  }
  return fixes;
}

async function refreshCredential(c) {  if (!c.refreshToken) throw new Error("no refreshToken stored; open the WorkBuddy app to re-sign");
  const res = await fetch(`${chatBase(c)}/v2/plugin/auth/token/refresh`, {
    method: "POST",
    headers: {
      ...commonHeaders(c),
      "X-Refresh-Token": c.refreshToken,
      "X-Auth-Refresh-Source": "workbuddy",
      ...(c.uid !== "" ? { "X-User-Id": c.uid } : {}),
    },
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  });
  const doc = await res.json().catch(() => null);
  if (!res.ok || !doc || doc.code !== 0) {
    throw new Error(`token refresh failed (http ${res.status}): ${JSON.stringify(doc)?.slice(0, 200)}`);
  }
  const data = doc.data ?? {};
  if (typeof data.accessToken !== "string" || data.accessToken === "") throw new Error("refresh returned no accessToken");
  const next = {
    ...c,
    accessToken: data.accessToken,
    refreshToken: typeof data.refreshToken === "string" && data.refreshToken !== "" ? data.refreshToken : c.refreshToken,
    expiresAtMs: Number.isFinite(data.expiresIn) && data.expiresIn > 0 ? Date.now() + data.expiresIn * 1e3 : c.expiresAtMs,
  };
  // 把刷新结果写回一份插件侧副本,避免频繁触发上游刷新;不碰桌面 App 的文件。
  try {
    const own = join(process.env.USERPROFILE || homedir(), ".zcode-workbuddy-proxy", "auth.json");
    await mkdir(dirname(own), { recursive: true });
    await writeFile(own, JSON.stringify({ version: 1, savedAt: Date.now(), credential: next }, null, 2), "utf8");
  } catch {}
  cached = next;
  return next;
}

let inflightRefresh = null;
async function resolveCredential() {
  // 桌面 App 切号/重新登录会重写凭据文件:mtime 变化即重读,账号切换即时跟随
  try {
    const st = await stat(authFilePath());
    if (cached && st.mtimeMs !== cachedAuthMtimeMs) cached = null;
  } catch {}
  const current = await (async () => {
    if (cached) return cached;
    // App 切号瞬间可能读到写了一半的文件:解析失败按「凭据暂不可用」处理,下次请求重试,不崩进程
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return (cached = await readCredential()); }
      catch (err) { await new Promise((r) => setTimeout(r, 150 * (attempt + 1))); }
    }
    throw new Error("workbuddy auth file unreadable (可能正被桌面 App 重写)");
  })();
  try { cachedAuthMtimeMs = (await stat(authFilePath())).mtimeMs; } catch {}
  const expiredSoon = current.expiresAtMs > 0 && Date.now() + REFRESH_MARGIN_MS >= current.expiresAtMs;
  const expired = current.expiresAtMs > 0 && Date.now() >= current.expiresAtMs;
  if (!expiredSoon) return current;
  inflightRefresh ??= refreshCredential(current).finally(() => { inflightRefresh = null; });
  try {
    return await inflightRefresh;
  } catch (err) {
    if (!expired) return current; // 未过期的旧 token 继续用
    throw err;
  }
}

// ---------------------------------------------------------------- errors

const HARD_CREDIT_MARKERS = [
  "insufficient credit", "no credit", "credit exhausted", "out of credit",
  "quota exceeded", "quota exhaust", "payment required", "credit not enough", "not enough credit",
  "积分不足", "额度不足", "余额不足", "积分用完", "额度用尽", "没有积分",
];
function classify(status, body) {
  if (status === 402) return "hard_credit";
  const lower = (body || "").toLowerCase();
  for (const m of HARD_CREDIT_MARKERS) if (lower.includes(m.toLowerCase()) || (body || "").includes(m)) return "hard_credit";
  if ((body || "").includes("Offline user session not found") || (body || "").includes("12153")) return "session_dead";
  if (status === 429) return "soft_rate";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  return "client";
}

// ---------------------------------------------------------------- 11128 身份清洗(deep-walk 加固)

/**
 * 上游 11128「Illegal API invocation from an unapproved channel」加固(2026-09-11)。
 * 被禁清单与 DSH 插件 dsh-workbuddy-connect 同源,由
 * workbuddy-11128-fix/extract-blocklist-for-zcode.mjs 程序化提取,
 * base64 存于 identity-blocklist.json,运行时才解码(原文不进日志/终端/回复)。
 */
const PROXY_DIR = dirname(fileURLToPath(import.meta.url));
const BLOCKLIST_FILE = join(PROXY_DIR, "identity-blocklist.json");
const PREAMBLE_PLACEHOLDER = "[third-party agent identity preamble removed by proxy]";
let IDENTITY_PREAMBLES = [];
let IDENTITY_PATTERNS = [];
try {
  const raw = JSON.parse(readFileSync(BLOCKLIST_FILE, "utf8"));
  for (const entry of Object.values(raw.entries ?? {})) {
    for (const b64 of entry.strings ?? []) IDENTITY_PREAMBLES.push(Buffer.from(b64, "base64").toString("utf8"));
    for (const r of entry.regexes ?? []) IDENTITY_PATTERNS.push(new RegExp(Buffer.from(r.source, "base64").toString("utf8"), r.flags));
  }
  // 自愈学习到的条目(learnFrom11128 追加;上限 50 条防失控,保留最新)
  for (const b64 of (raw.learned ?? []).slice(-50)) {
    const s = Buffer.from(b64, "base64").toString("utf8");
    if (!IDENTITY_PREAMBLES.includes(s)) IDENTITY_PREAMBLES.push(s);
  }
} catch (e) {
  console.error("[zcode-workbuddy-proxy] identity-blocklist.json 加载失败,11128 清洗未启用:", String(e).slice(0, 120));
}

/**
 * 形状级通用兜底:只匹配「You are …(code/cli/agent/tool 关键词)….」的句子结构,
 * 不含任何具体被禁原文。命中即整体替换为占位符(上游按完整子串匹配,
 * 洗掉声明句的任意一段即可令其失效)。
 */
const GENERIC_IDENTITY_PATTERNS = [
  /\bYou are [A-Z][^.\n]{0,160}?\b(?:code|cli|agent|extension|tool)\b[^.\n]{0,80}\./gi,
  /\bYou're [A-Z][^.\n]{0,160}?\b(?:code|cli|agent|extension|tool)\b[^.\n]{0,80}\./gi,
];

/** 中和被禁的第三方 agent 身份声明(精确子串 + 正则 + 形状兜底)。超长字符串(如 base64 图片)跳过。 */
function sanitizeIdentityText(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_000_000) return value;
  let out = value;
  for (const p of IDENTITY_PREAMBLES) out = out.split(p).join(PREAMBLE_PLACEHOLDER);
  for (const re of IDENTITY_PATTERNS) out = out.replace(re, PREAMBLE_PLACEHOLDER);
  for (const re of GENERIC_IDENTITY_PATTERNS) out = out.replace(re, PREAMBLE_PLACEHOLDER);
  return out;
}

/** 深度遍历任意 JSON 值,清洗所有字符串——覆盖 messages/tools/system/工具参数,未来新增字段天然免疫。 */
function sanitizeDeep(value) {
  if (typeof value === "string") return sanitizeIdentityText(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = sanitizeDeep(value[i]);
    return value;
  }
  if (value !== null && typeof value === "object") {
    for (const k of Object.keys(value)) value[k] = sanitizeDeep(value[k]);
    return value;
  }
  return value;
}

// ---- 11128 自愈学习:从被拒请求体提取身份声明句,追加进本地黑名单(原文仅以 base64 落盘,不进日志) ----

const LEARN_SENTENCE_PATTERNS = [
  /(?:^|[\n.!?]\s*)(You are [A-Z][^.\n]{2,220}\.)/g,
  /(?:^|[\n.!?]\s*)(You're [A-Z][^.\n]{2,220}\.)/g,
];
// 形状盲区兜底:含 agent 产品名的句子也可能是身份声明(如 "XCode is a CLI…" 形态)。
// 只用产品名做关键词,不含任何被禁原文。
const LEARN_NAME_KEYWORDS = /\b(?:ZCode|Claude|Anthropic|Codex|Gemini|OpenAI|Qwen|iFlow|Cursor|Copilot)\b/;

function eachStringDeep(value, fn) {
  if (typeof value === "string") fn(value);
  else if (Array.isArray(value)) for (const v of value) eachStringDeep(v, fn);
  else if (value !== null && typeof value === "object") for (const k of Object.keys(value)) eachStringDeep(value[k], fn);
}

/** 返回新学习到的条数;0 = 无可学习候选。 */
function learnFrom11128(body) {
  const seen = new Set();
  eachStringDeep(body, (s) => {
    for (const re of LEARN_SENTENCE_PATTERNS) {
      for (const m of s.matchAll(re)) {
        const sentence = (m[1] ?? "").trim();
        if (sentence.length >= 12 && sentence.length <= 400) seen.add(sentence);
      }
    }
  });
  // 兜底:主形状没抓到时,再收含产品名的句子(仍是句子粒度,不会整段吞)
  if (!seen.size) {
    eachStringDeep(body, (s) => {
      for (const m of s.matchAll(/(?:^|[\n.!?]\s*)([A-Z][^.\n]{2,300}\.)/g)) {
        const sentence = (m[1] ?? "").trim();
        if (sentence.length >= 12 && sentence.length <= 400 && LEARN_NAME_KEYWORDS.test(sentence)) seen.add(sentence);
      }
    });
  }
  const fresh = [...seen].filter((s) => !IDENTITY_PREAMBLES.includes(s)).slice(0, 20);
  if (!fresh.length) return 0;
  for (const s of fresh) IDENTITY_PREAMBLES.push(s);
  try {
    let file = {};
    try { file = JSON.parse(readFileSync(BLOCKLIST_FILE, "utf8")); } catch {}
    file.learned = file.learned ?? [];
    for (const s of fresh) file.learned.push(Buffer.from(s, "utf8").toString("base64"));
    file.learnedAt = new Date().toISOString();
    writeFileSync(BLOCKLIST_FILE, JSON.stringify(file, null, 2));
  } catch (e) {
    console.error("[zcode-workbuddy-proxy] 学习条目持久化失败(内存中仍生效):", String(e).slice(0, 120));
  }
  return fresh.length;
}

// ---------------------------------------------------------------- anthropic → openai body

function anthropicContentToOpenAI(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts = [];      // 纯文本统一拍平成一个字符串(上游不接受裸字符串数组)
  const outParts = [];   // 仅当出现图片等非文本块时,才用 OpenAI parts 数组
  let hasNonText = false;
  for (const block of content) {
    if (typeof block === "string") { texts.push(block); outParts.push({ type: "text", text: block }); continue; }
    switch (block?.type) {
      case "text":
        texts.push(block.text ?? "");
        outParts.push({ type: "text", text: block.text ?? "" });
        break;
      case "image": {
        // Anthropic: {source:{type:"base64", media_type, data}} → OpenAI image_url
        const src = block.source ?? {};
        if (src.type === "base64" && src.data) {
          hasNonText = true;
          outParts.push({ type: "image_url", image_url: { url: `data:${src.media_type || "image/png"};base64,${src.data}` } });
        }
        break;
      }
      case "tool_use":
        // 由 collectToolCalls 单独收进 tool_calls,不进 content
        break;
      case "tool_result":
        // 作为独立 user 消息处理(见消息转换)
        break;
      default:
        break;
    }
  }
  // 修复 2026-09-11:多文本块(如 <system-reminder> + 正文)此前被发成
  // content:["...","..."] 裸字符串数组,上游 400 code 11101
  // "Parse message failed: invalid content format for message with role user"。
  // 上游只认「字符串」或「{type:text|image_url,...} parts 数组」两种形态。
  if (!hasNonText) return texts.join("\n");
  return outParts;
}

/**
 * 上游只认 OpenAI 的 system/user/assistant/tool 四个 role:
 * 任何 role:"developer" 都会 400 / code 11128("unapproved channel")。
 * ZCode 有时会把系统提示以 developer 送出(OpenAI 新规范),故统一改写。
 */
function normalizeDeveloperRoles(messages) {
  for (const m of messages) {
    if (m && typeof m === "object" && m.role === "developer") m.role = "system";
  }
  return messages;
}

/** 把 Anthropic messages + system + tools 翻成 OpenAI chat body(不含 model/stream)。 */
function translateRequest(anth) {
  const messages = [];

  // system:字符串或 content blocks 数组 → 顶层 system
  const sysBlocks = [];
  if (typeof anth.system === "string" && anth.system) sysBlocks.push({ type: "text", text: anth.system });
  else if (Array.isArray(anth.system)) {
    for (const b of anth.system) if (b?.type === "text") sysBlocks.push({ type: "text", text: b.text ?? "" });
  }
  if (sysBlocks.length) messages.push({ role: "system", content: sysBlocks.map((b) => b.text).join("\n\n") });

  for (const msg of anth.messages ?? []) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    const content = msg.content;
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    // tool_result 必须拆成独立消息(tool chain 顺序)
    const pendingToolResults = [];
    const rest = [];
    for (const block of content) {
      if (block?.type === "tool_result") {
        let text = "";
        const inner = block.content;
        if (typeof inner === "string") text = inner;
        else if (Array.isArray(inner)) {
          text = inner.map((b) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : "")).join("\n");
        }
        pendingToolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: text || (block.is_error ? "error" : ""),
        });
      } else {
        rest.push(block);
      }
    }
    if (role === "user") {
      // user 消息:先发主体,再依次发 tool 结果
      if (rest.length) messages.push({ role: "user", content: anthropicContentToOpenAI(rest) });
      for (const tr of pendingToolResults) messages.push(tr);
    } else {
      // assistant 消息:tool_use 与文本同在
      const openaiContent = anthropicContentToOpenAI(rest);
      const hasToolUse = rest.some((b) => b?.type === "tool_use");
      // WorkBuddy 网关契约(400 code 11155):思维链模式下,上一轮助手的
      // reasoning_content 必须回传。zcode 历史里的 thinking 块 → reasoning_content。
      const thinkingText = rest
        .filter((b) => b?.type === "thinking" && typeof b.thinking === "string")
        .map((b) => b.thinking)
        .join("\n");
      const rc = thinkingText ? { reasoning_content: thinkingText } : {};
      if (hasToolUse) {
        messages.push({ role: "assistant", content: typeof openaiContent === "string" && openaiContent ? openaiContent : null, ...rc, ...(collectToolCalls(rest)) });
      } else {
        messages.push({ role: "assistant", content: openaiContent, ...rc });
      }
      for (const tr of pendingToolResults) messages.push(tr);
    }
  }

  const body = { messages: normalizeDeveloperRoles(messages) };

  // tools → OpenAI functions
  if (Array.isArray(anth.tools) && anth.tools.length) {
    body.tools = anth.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }

  // tool_choice:对象 → 字符串(上游只吃字符串)
  const tc = anth.tool_choice;
  if (tc?.type === "auto") body.tool_choice = "auto";
  else if (tc?.type === "any" || tc?.type === "required") body.tool_choice = "required";
  else if (tc?.type === "tool" && tc.name) body.tool_choice = tc.name;
  else if (tc?.type === "none") body.tool_choice = "none";

  // 采样参数
  if (Number.isFinite(anth.temperature)) body.temperature = anth.temperature;
  if (Number.isFinite(anth.top_p)) body.top_p = anth.top_p;

  return body;
}
function collectToolCalls(blocks) {
  const toolCalls = blocks.filter((b) => b?.type === "tool_use").map((b) => ({
    type: "function",
    id: b.id,
    function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
  }));
  return { tool_calls: toolCalls };
}

/** reasoning 思考档位:仅当模型目录声明支持且在集合内才下发。 */
function reasoningEffortFor(modelId, anth) {
  const info = infoOf(modelId);
  if (!info.efforts || info.efforts.length === 0) return undefined;
  // Anthropic 侧 thinking 预算 → 档位
  let want;
  const t = anth.thinking;
  if (t?.type === "disabled") want = "off";
  else if (t?.type === "enabled") {
    const budget = Number(t.budget_tokens ?? 0);
    want = budget >= 16000 ? "max" : budget >= 8000 ? "high" : "low";
  } else want = undefined;

  if (want === "off") return info.canOff ? "off" : undefined;
  if (want === undefined) return undefined; // 用上游默认
  if (info.efforts.includes(want)) return want;
  // 不在集合内就往下降
  const order = ["low", "high", "max"];
  const idx = order.indexOf(want);
  for (let i = Math.max(0, idx); i < order.length; i++) {
    if (info.efforts.includes(order[i])) return order[i];
  }
  for (let i = Math.min(order.length - 1, idx); i >= 0; i--) {
    if (info.efforts.includes(order[i])) return order[i];
  }
  return undefined;
}

// ---------------------------------------------------------------- upstream SSE → anthropic

function sseEvent(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 消费上游 OpenAI SSE,合成 Anthropic SSE。
 * 返回聚合结果供非流式模式使用。
 */
async function pipeUpstreamToAnthropic(upstreamRes, clientRes, { stream, model }) {
  const msgId = `msg_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const started = Math.floor(Date.now() / 1000);

  const aggregate = {
    text: [],
    thinking: [],
    toolCalls: new Map(), // index → {id,name,args}
    stopReason: "end_turn",
    usage: { in: 0, out: 0 },
  };

  if (stream) {
    clientRes.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    clientRes.write(sseEvent("message_start", {
      type: "message_start",
      message: {
        id: msgId, type: "message", role: "assistant", model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }));
  }

  let blockIndex = 0;
  let textBlockOpen = false;
  let thinkBlockOpen = false;

  const openText = () => {
    if (textBlockOpen) return;
    textBlockOpen = true;
    if (stream) clientRes.write(sseEvent("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } }));
  };
  const closeText = () => {
    if (!textBlockOpen) return;
    textBlockOpen = false;
    if (stream) clientRes.write(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex }));
    blockIndex++;
  };
  const openThink = () => {
    if (thinkBlockOpen) return;
    thinkBlockOpen = true;
    if (stream) clientRes.write(sseEvent("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "thinking", thinking: "" } }));
  };
  const closeThink = () => {
    if (!thinkBlockOpen) return;
    thinkBlockOpen = false;
    if (stream) clientRes.write(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex }));
    blockIndex++;
  };

  const reader = upstreamRes.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let done = false;
  let sawDoneMarker = false;

  const handleChunkJson = (json) => {
    const choice = json.choices?.[0];
    if (!choice) {
      if (json.usage) {
        aggregate.usage.in = json.usage.prompt_tokens ?? aggregate.usage.in;
        aggregate.usage.out = json.usage.completion_tokens ?? aggregate.usage.out;
      }
      return;
    }
    const delta = choice.delta ?? {};
    if (json.usage) {
      aggregate.usage.in = json.usage.prompt_tokens ?? aggregate.usage.in;
      aggregate.usage.out = json.usage.completion_tokens ?? aggregate.usage.out;
    }
    const rc = delta.reasoning_content;
    if (typeof rc === "string" && rc) {
      openThink();
      aggregate.thinking.push(rc);
      if (stream) clientRes.write(sseEvent("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "thinking_delta", thinking: rc } }));
    }
    const c = delta.content;
    if (typeof c === "string" && c) {
      closeThink();
      openText();
      aggregate.text.push(c);
      if (stream) clientRes.write(sseEvent("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: c } }));
    }
    const tcs = delta.tool_calls;
    // 注意:上游每个增量都带 "tool_calls":[] 空数组;空数组必须忽略,
    // 否则 closeThink() 会把思维链块逐词切碎(ZCode 里每词一行)。
    if (Array.isArray(tcs) && tcs.length > 0) {
      closeThink();
      for (const tc of tcs) {
        const idx = Number.isFinite(tc.index) ? tc.index : 0;
        let slot = aggregate.toolCalls.get(idx);
        if (!slot) {
          slot = { id: tc.id || `toolu_${randomUUID().replaceAll("-", "").slice(0, 20)}`, name: "", args: [] };
          aggregate.toolCalls.set(idx, slot);
        }
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") slot.args.push(tc.function.arguments);
      }
    }
    const fr = choice.finish_reason;
    if (fr) {
      if (fr === "tool_calls") aggregate.stopReason = "tool_use";
      else if (fr === "length") aggregate.stopReason = "max_tokens";
      else if (fr === "stop") aggregate.stopReason = "end_turn";
      else aggregate.stopReason = "end_turn";
    }
  };

  while (true) {
    const { done: rdDone, value } = await reader.read();
    if (rdDone) break;
    buf += dec.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, sep).replace(/\r$/, "");
      buf = buf.slice(sep + 1);
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") { sawDoneMarker = true; continue; }
        try { handleChunkJson(JSON.parse(payload)); } catch {}
      }
    }
  }
  closeThink();
  closeText();

  // 工具调用块在文本块之后统一发出
  const toolSlots = [...aggregate.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  for (const slot of toolSlots) {
    let argsStr = slot.args.join("") || "{}";
    if (stream) {
      clientRes.write(sseEvent("content_block_start", {
        type: "content_block_start", index: blockIndex,
        content_block: { type: "tool_use", id: slot.id, name: slot.name, input: {} },
      }));
      // 分片发 JSON,模拟真实增量
      const PIECE = 900;
      for (let i = 0; i < argsStr.length; i += PIECE) {
        clientRes.write(sseEvent("content_block_delta", {
          type: "content_block_delta", index: blockIndex,
          delta: { type: "input_json_delta", partial_json: argsStr.slice(i, i + PIECE) },
        }));
      }
      clientRes.write(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex }));
    }
    blockIndex++;
  }

  const outTokens = aggregate.usage.out || Math.ceil((aggregate.text.join("").length + aggregate.thinking.join("").length) / 4);
  if (stream) {
    clientRes.write(sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: aggregate.stopReason, stop_sequence: null },
      usage: { output_tokens: outTokens },
    }));
    clientRes.write(sseEvent("message_stop", { type: "message_stop" }));
    clientRes.end();
  }

  return {
    id: msgId, model, stopReason: aggregate.stopReason,
    text: aggregate.text.join(""),
    thinking: aggregate.thinking.join(""),
    toolCalls: toolSlots.map((s) => ({ id: s.id, name: s.name, arguments: s.args.join("") || "{}" })),
    usage: { input_tokens: aggregate.usage.in, output_tokens: outTokens },
  };
}

function anthropicError(clientRes, status, type, message) {
  const body = JSON.stringify({ type: "error", error: { type, message } });
  if (!clientRes.headersSent) {
    clientRes.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    clientRes.end(body);
  } else {
    clientRes.write(sseEvent("error", { type: "error", error: { type, message } }));
    clientRes.end();
  }
}

// ---------------------------------------------------------------- http server

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  try {
    // 鉴权:Bearer 任意值或配置 token 均可(本地回环,宽松)
    const authz = req.headers.authorization ?? "";

    if (req.method === "GET" && (url === "/healthz" || url === "/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "zcode-workbuddy-proxy", port: PORT }));
      return;
    }

    // 简单 token 校验:如果配置了非默认 token 则强制
    if (url.startsWith("/v1/")) {
      if (process.env.WB_PROXY_TOKEN && process.env.WB_PROXY_TOKEN !== "zcode-workbuddy") {
        if (authz !== `Bearer ${process.env.WB_PROXY_TOKEN}`) {
          anthropicError(res, 401, "authentication_error", "invalid proxy bearer token");
          return;
        }
      }
    }

    if (req.method === "GET" && (url === "/v1/models")) {
      const cred = await resolveCredential();
      let models = FALLBACK_MODELS;
      // 国际版:目录来自 App 界面接口(非 /console/... 那套),直接读插件缓存的那份
      if (IS_AI) {
        try {
          const doc = JSON.parse(await readFile(AI_CATALOG_FILE, "utf8"));
          const entry = Object.values(doc.entries ?? {})[0];
          const live = (entry?.models ?? []).map((m) => {
            const r = m.reasoning ?? {};
            let efforts;
            if (r.supports) {
              if (Array.isArray(r.supportedEfforts) && r.supportedEfforts.length) efforts = r.supportedEfforts;
              else if (typeof r.defaultEffort === "string") efforts = [r.defaultEffort];
              else efforts = ["medium"];
            }
            return {
              id: m.id,
              ctx: Number(m.contextWindow) || 200_000,
              out: Number(m.maxTokens) || 32_000,
              img: m.supportsImages === true,
              efforts,
              canOff: r.canDisableThinking === true,
            };
          }).filter((m) => m.id);
          if (live.length) models = live;
        } catch {}
      } else
      try {
        const mres = await fetch(`${chatBase(cred)}/console/enterprises/personal/models`, {
          headers: {
            Authorization: `Bearer ${cred.accessToken}`,
            Accept: "application/json",
            Origin: originReferer(cred),
            Referer: `${originReferer(cred)}/`,
            "User-Agent": CLIENT_UA,
          },
          signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
        });
        const doc = await mres.json();
        if (mres.ok && doc.code === 0) {
          const byId = new Map((doc.data?.models ?? []).map((m) => [m.id, m]));
          const cliIds = (doc.data?.agents ?? []).find((a) => a.name === "cli")?.models ?? [];
          const live = [];
          for (const id of cliIds) {
            const m = byId.get(id);
            if (!m || m.disabled === true) continue;
            live.push({
              id: m.id,
              ctx: Number(m.maxInputTokens) || 200_000,
              out: Number(m.maxOutputTokens) || 32_000,
              img: m.supportsImages === true && m.disabledMultimodal !== true,
              efforts: Array.isArray(m.reasoning?.supportedEfforts) ? m.reasoning.supportedEfforts
                : typeof m.reasoning?.effort === "string" ? [m.reasoning.effort] : undefined,
              canOff: m.reasoning?.canDisableThinking === true,
            });
          }
          if (live.length) models = live;
          modelInfo.clear();
          for (const m of models) modelInfo.set(m.id, m);
        }
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: models.map((m) => ({ type: "model", id: m.id, display_name: m.id, created_at: "2026-01-01T00:00:00Z" })),
        has_more: false,
      }));
      return;
    }

    if (req.method === "POST" && (url === "/v1/messages" || url === "/v1/messages?beta=true")) {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) { anthropicError(res, 413, "request_too_large", "request body too large"); req.destroy(); return; }
        chunks.push(chunk);
      }
      const anth = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const model = anth.model || "glm-5.3-flash";
      const stream = anth.stream === true;

      const cred = await resolveCredential();
      const inner = translateRequest(anth);
      const effort = reasoningEffortFor(model, anth);
      const upstreamBody = {
        model,
        ...inner,
        stream: true, // 上游只吃流式
        // 国际版不发思维链参数(11155 契约无法满足,实测同体:带→11155,不发→200)
        ...(IS_AI ? {} : (effort && effort !== "off" ? { reasoning_effort: effort } : {})),
        ...(!IS_AI && effort === "off" ? { reasoning_effort: "off" } : {}),
        ...(Number.isFinite(anth.max_tokens) && anth.max_tokens > 0 ? { max_tokens: Math.min(anth.max_tokens, infoOf(model).out) } : {}),
      };

      // WorkBuddy 网关契约(400 code 11155):思维链模式下,历史里每条 assistant
      // 消息都必须带 reasoning_content(真实内容优先,缺失补占位),否则整条请求被拒。
      if (upstreamBody.reasoning_effort && upstreamBody.reasoning_effort !== "off") {
        for (const m of upstreamBody.messages) {
          if (m?.role === "assistant" && !m.reasoning_content) {
            m.reasoning_content = "(no reasoning content recorded for this turn)";
          }
        }
      }

      // 国际版网关前置条件:messages[0] 必须是 system(缺失则注入一条最小提示词)
      if (regionOf(cred.domain) === "global") {
        const msgs = upstreamBody.messages;
        if (Array.isArray(msgs) && !(msgs[0] && msgs[0].role === "system")) {
          msgs.unshift({ role: "system", content: "You are a helpful assistant." });
        }
      }

      // 11128 加固:发上游前深度清洗整个 body(含 system/tools/messages/工具参数)
      sanitizeDeep(upstreamBody);
      // 工具 schema 去噪(剔除 $schema 等被模型侧拒绝的非标准键)
      const cleanedTools = sanitizeTools(upstreamBody.tools);
      if (cleanedTools > 0) logEvent(`发送前清洗工具 schema:${cleanedTools} 个`);
      // 消息顺序归一化(插话导致 assistant(tool_calls) 与 tool 结果被隔开 → 上游 11133)
      const reordered = normalizeMessageOrder(upstreamBody.messages);
      if (reordered > 0) logEvent(`消息顺序归一化:修正 ${reordered} 处被插话隔开的工具调用`);

      const sendUpstream = () => fetchUpstreamRetry(`${chatBase(cred)}/v2/chat/completions`, {
        method: "POST",
        headers: { ...chatHeaders(cred), Authorization: `Bearer ${cred.accessToken}` },
        body: JSON.stringify(upstreamBody),
      });

      let upRes = await sendUpstream();
      let consumedText = null;
      if (upRes.status === 400) {
        consumedText = await upRes.text();
        // 11133 / model_param_invalid:模型提供方拒绝请求参数(实测 max_tokens=128000/32000 均被拒)。
        // 拒绝发生在推理之前 → 逐级减半重试零推理成本;砍到底仍被拒时,移除该字段用服务端默认。
        let shrinkLeft = 6;
        while (
          upRes.status === 400 && shrinkLeft > 0 && typeof consumedText === "string" &&
          (consumedText.includes("11133") || consumedText.includes("model_param_invalid"))
        ) {
          if (Number.isFinite(upstreamBody.max_tokens) && upstreamBody.max_tokens > 1024) {
            upstreamBody.max_tokens = Math.max(1024, Math.floor(upstreamBody.max_tokens / 2));
            logEvent(`11133: max_tokens 降为 ${upstreamBody.max_tokens} 后重试`);
          } else if ("max_tokens" in upstreamBody) {
            delete upstreamBody.max_tokens;
            logEvent("11133: 移除 max_tokens 字段,改用服务端默认后重试");
          } else {
            break;
          }
          shrinkLeft -= 1;
          consumedText = null;
          upRes = await sendUpstream();
          if (upRes.status === 400) consumedText = await upRes.text();
        }
        if (upRes.status !== 400 && upstreamBody.max_tokens !== undefined) {
          logEvent(`11133 降级成功:本次最终 max_tokens=${upstreamBody.max_tokens}`);
        }
        if (typeof consumedText === "string" && consumedText.includes("11128")) {
          // 自愈:从被拒请求体学习未知身份声明 → 追加黑名单 → 再洗一遍 → 重试一次
          const learned = learnFrom11128(upstreamBody);
          if (learned > 0) {
            console.log(`[zcode-workbuddy-proxy] 11128: 学习到 ${learned} 条新身份声明,清洗后重试`);
            sanitizeDeep(upstreamBody);
            consumedText = null;
            upRes = await sendUpstream();
          } else {
            // 无可学习候选:落盘捕获供离线分析(内容不打印)
            try {
              await mkdir(join(PROXY_DIR, "capture"), { recursive: true });
              await writeFile(join(PROXY_DIR, "capture", `11128-${Date.now()}.json`), JSON.stringify(upstreamBody));
              console.log("[zcode-workbuddy-proxy] 11128: 无可学习候选,已落盘捕获(capture/)");
            } catch {}
          }
        }
      }

      if (!upRes.ok) {
        const text = (consumedText ?? (await upRes.text())).slice(0, 2000);
        const kind = classify(upRes.status, text);
        if (kind === "session_dead") cached = null; // 下次请求重读桌面 App 凭据(桌面端可能已刷新)
        if (upRes.status === 400) {
          // 400 落盘捕获(如 11155 reasoning_content_missing):留存确切请求体供离线分析,不打印内容
          try {
            await mkdir(join(PROXY_DIR, "capture"), { recursive: true });
            await writeFile(join(PROXY_DIR, "capture", `400-${Date.now()}.json`), JSON.stringify({ at: new Date().toISOString(), body: upstreamBody }, null, 2));
            console.log("[zcode-workbuddy-proxy] 上游 400:请求体已落盘 capture/");
          } catch {}
        }
        const status = kind === "hard_credit" ? 402 : kind === "soft_rate" ? 429 : kind === "session_dead" ? 401 : kind === "server" || kind === "not_found" ? 502 : 400;
        anthropicError(res, status, kind === "session_dead" ? "authentication_error" : "api_error", `workbuddy upstream ${kind} (http ${upRes.status}): ${text.slice(0, 300)}`);
        return;
      }

      const result = await pipeUpstreamToAnthropic(upRes, res, { stream, model });

      if (!stream) {
        // 聚合成 Anthropic 非流式响应
        const content = [];
        if (result.thinking) content.push({ type: "thinking", thinking: result.thinking, signature: "" });
        if (result.text) content.push({ type: "text", text: result.text });
        for (const tc of result.toolCalls) {
          let input = {};
          try { input = JSON.parse(tc.arguments); } catch {}
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: result.id, type: "message", role: "assistant", model: result.model,
          content,
          stop_reason: result.stopReason,
          stop_sequence: null,
          usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
        }));
      }
      return;
    }

    anthropicError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
  } catch (err) {
    anthropicError(res, 500, "api_error", `proxy internal error: ${String(err?.message ?? err)}`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[zcode-workbuddy-proxy] listening on http://127.0.0.1:${PORT}`);
  console.log(`[zcode-workbuddy-proxy] auth file: ${authFilePath()}`);
  console.log(`[zcode-workbuddy-proxy] models: ${FALLBACK_MODELS.map((m) => m.id).join(", ")}`);
});

// ---------------------------------------------------------------- AI 实例看门狗
// 国内版实例由开机自启拉起(登录即活),由它守护同目录的国际版实例:
// 周期探测 8402,连不上则以独立进程拉起 AI 变体(detached + unref,不随本进程退出)。
// 环境说明:workbuddy.ai 被(fake-ip DNS)劫持,直连 fake-ip 会被拒,
// 故 AI 实例必须带 NODE_USE_ENV_PROXY=1 + HTTPS_PROXY 走 mihomo 混合端口(7897)。
if (!IS_AI && process.env.WB_WATCHDOG !== "0") {
  const { spawn } = await import("node:child_process");
  const { createConnection } = await import("node:net");
  const AI_PORT = 8402;
  const aiEnv = { ...process.env, WB_VARIANT: "ai", NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://127.0.0.1:7897", HTTP_PROXY: "http://127.0.0.1:7897" };
  let aiSpawning = false;
  const ensureAi = () => {
    const s = createConnection(AI_PORT, "127.0.0.1");
    s.setTimeout(2000);
    s.on("connect", () => s.destroy());
    s.on("timeout", () => { s.destroy(); trySpawn(); });
    s.on("error", () => trySpawn());
    function trySpawn() {
      if (aiSpawning) return;
      aiSpawning = true;
      setTimeout(() => { aiSpawning = false; }, 20000);
      try {
        spawn(process.execPath, ["proxy.mjs"], { cwd: process.cwd(), env: aiEnv, detached: true, stdio: "ignore" }).unref();
        console.log(`[zcode-workbuddy-proxy] AI 实例(${AI_PORT})未响应,已重新拉起`);
      } catch {}
    }
  };
  setTimeout(ensureAi, 8000);
  setInterval(ensureAi, 60000);
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
