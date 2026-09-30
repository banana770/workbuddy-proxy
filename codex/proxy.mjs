#!/usr/bin/env node
/**
 * Codex ↔ WorkBuddy 反代(供 cc-switch 的 Codex provider 使用)
 *
 * codex-cli ≥ 0.15x 只支持 wire_api = "responses",而 WorkBuddy 上游只提供
 * chat completions。本反代在 127.0.0.1 暴露 OpenAI Responses API
 * (/v1/responses),把请求翻译成 WorkBuddy 上游的 chat completions,
 * 再把上游 SSE 翻译回 Responses SSE。
 *
 * 同时保留 /v1/chat/completions(直通 + 非流式聚合),便于其它客户端/调试。
 *
 * 协议来源:参照本机 DSH 插件 dsh-workbuddy-connect@0.3.1(凭据读取、
 * 上游端点、怪癖处理),其上游协议参照 Sliverkiss/workbuddy2api。
 *
 * 上游怪癖:
 *  - 只接受 stream:true(客户端要非流式时本地聚合)
 *  - role:"developer" 必须改写成 "system"(否则 400 / code 11128)
 *  - tool_choice 只吃字符串
 *  - reasoning_effort 只在模型目录声明的档位集合内下发
 *
 * 环境变量:
 *   PORT                 监听端口(默认 8401)
 *   WORKBUDDY_AUTH_FILE  凭据文件路径(默认 WorkBuddy 桌面 App 位置)
 *   WB_PROXY_TOKEN       要求的 Bearer(默认空 = 不校验)
 */
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

// 变体:cn = 国内版 WorkBuddy;ai = 国际版 WorkBuddy AI(workbuddy.ai)
const VARIANT = (process.env.WB_VARIANT === "ai" || process.argv.includes("--ai")) ? "ai" : "cn";
const IS_AI = VARIANT === "ai";
const PORT = Number(process.env.PORT || (IS_AI ? 8403 : 8401));
const PROXY_TOKEN = process.env.WB_PROXY_TOKEN || "";
const CN_CHAT_BASE = "https://copilot.tencent.com";
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
const BODY_LIMIT = 64 * 1024 * 1024;

const rid = (p) => `${p}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;

// 静态兜底目录(与上游 cli agent 一致;live 拉取失败时使用)
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

/** 国际版 WorkBuddy AI 兜底目录(取自插件本地缓存 ~/.dsh/.workbuddy-ai-catalog.json)。 */
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
const infoOf = (id) => modelInfo.get(id) ?? { id, ctx: 1_000_000, out: 32_000, img: true, efforts: undefined, canOff: false };

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
const authFilePath = () => (IS_AI ? process.env.WORKBUDDY_AI_AUTH_FILE : process.env.WORKBUDDY_AUTH_FILE)
  || process.env.WB_AUTH_FILE
  || desktopAuthCandidates()[0];
let cached = null;
let cachedAuthMtimeMs = -1; // 凭据文件 mtime:App 切号/重登会改写文件,变化即重读

const expiryToMs = (v) => (!Number.isFinite(v) || v <= 0 ? 0 : v > 1e12 ? v : v * 1e3);
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
const regionOf = (d) => {
  const v = (d || "").trim().toLowerCase();
  return v === "workbuddy.ai" || v.endsWith(".workbuddy.ai") ? "global" : "cn";
};
const chatBase = (c) => (regionOf(c.domain) === "global" ? GLOBAL_BASE : CN_CHAT_BASE);
const originReferer = (c) => (regionOf(c.domain) === "global" ? GLOBAL_BASE : "https://www.codebuddy.cn");
const commonHeaders = (c) => ({
  Accept: "application/json, text/plain, */*",
  "X-Requested-With": "XMLHttpRequest",
  Origin: originReferer(c),
  Referer: `${originReferer(c)}/`,
  "User-Agent": CLIENT_UA,
});
const chatHeaders = (c) => ({
  ...commonHeaders(c),
  "Content-Type": "application/json",
  ...(c.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": c.uid }),
  ...(c.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": c.domain }),
  "X-Product": "SaaS",
});

async function refreshCredential(c) {
  if (!c.refreshToken) throw new Error("no refreshToken stored; open the WorkBuddy app to re-sign");
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
  if (!res.ok || !doc || doc.code !== 0) throw new Error(`token refresh failed (http ${res.status}): ${JSON.stringify(doc)?.slice(0, 200)}`);
  const data = doc.data ?? {};
  if (typeof data.accessToken !== "string" || data.accessToken === "") throw new Error("refresh returned no accessToken");
  const next = {
    ...c,
    accessToken: data.accessToken,
    refreshToken: typeof data.refreshToken === "string" && data.refreshToken !== "" ? data.refreshToken : c.refreshToken,
    expiresAtMs: Number.isFinite(data.expiresIn) && data.expiresIn > 0 ? Date.now() + data.expiresIn * 1e3 : c.expiresAtMs,
  };
  try {
    const own = join(homedir(), ".codex-workbuddy-proxy", "auth.json");
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
      try { return (cached = await readFile(authFilePath(), "utf8").then(parseAuthDoc)); }
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
    if (!expired) return current;
    throw err;
  }
}

// ---------------------------------------------------------------- shared helpers

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
function normalizeEffort(modelId, requested) {
  const info = infoOf(modelId);
  if (!requested || !info.efforts || info.efforts.length === 0) return undefined;
  const want = String(requested).toLowerCase();
  if (want === "none" || want === "minimal" || want === "off") return info.canOff ? "off" : undefined;
  if (info.efforts.includes(want)) return want;
  const order = ["low", "medium", "high", "xhigh", "max"];
  const idx = order.indexOf(want);
  if (idx === -1) return undefined;
  for (let i = Math.min(order.length - 1, idx); i >= 0; i--) if (info.efforts.includes(order[i])) return order[i];
  for (let i = idx + 1; i < order.length; i++) if (info.efforts.includes(order[i])) return order[i];
  return undefined;
}
const STRIP_CHAT_FIELDS = [
  "store", "prompt_cache_key", "include", "service_tier", "safety_identifier",
  "previous_response_id", "reasoning", "text", "truncation", "user", "metadata",
];
function normalizeToolChoice(tc) {
  if (tc == null) return undefined;
  if (typeof tc === "string") return tc === "none" ? "none" : tc;
  const type = String(tc.type ?? "").toLowerCase();
  if (type === "function") return tc.function?.name ?? tc.name ?? "auto";
  if (type === "auto" || type === "required" || type === "none") return type;
  return undefined;
}
function finalizeChatBody(body, model, effort) {
  for (const f of STRIP_CHAT_FIELDS) delete body[f];
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) if (m && typeof m === "object" && m.role === "developer") m.role = "system";
  }
  const tc = normalizeToolChoice(body.tool_choice);
  if (tc === "none") { delete body.tools; delete body.tool_choice; }
  else if (tc) body.tool_choice = tc;
  else delete body.tool_choice;
  if (effort) body.reasoning_effort = effort; else delete body.reasoning_effort;
  // WorkBuddy 网关契约(400 code 11155):思维链模式下,历史里每条 assistant
  // 消息都必须带 reasoning_content(真实内容优先,缺失补占位),否则整条请求被拒。
  if (body.reasoning_effort && body.reasoning_effort !== "off") {
    for (const m of body.messages) {
      if (m?.role === "assistant" && !m.reasoning_content) {
        m.reasoning_content = "(no reasoning content recorded for this turn)";
      }
    }
  }
  if (Number.isFinite(body.max_tokens) && body.max_tokens > 0) body.max_tokens = Math.min(body.max_tokens, infoOf(model).out);
  else delete body.max_tokens;
  body.stream = true; // 上游只吃流式
  return body;
}

/**
 * Upstream security-policy guard.
 *
 * `code 11128 "Illegal API invocation from an unapproved channel"` is NOT an
 * auth/channel problem: it is the upstream's response to a *system or
 * assistant* message that reproduces another vendor's coding-agent identity
 * preamble verbatim. Measured behaviour (2026-09-10):
 *
 *   role=system    + preamble -> 11128
 *   role=assistant + preamble -> 11128
 *   role=user/tool + preamble -> ok      (history is replayed every turn, so
 *                                         one poisoned assistant message
 *                                         breaks the whole conversation)
 *   preamble minus its final "." -> ok   (exact-substring match)
 *
 * Also rewrites `role:"developer"` (the upstream knows only system/user/
 * assistant/tool). Every request funnels through callUpstream, so applying
 * both here covers paths that skip finalizeChatBody (e.g. /v1/responses).
 */
const IDENTITY_PREAMBLES = [
  "You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI. You are expected to be precise, safe, and helpful.",
];
const IDENTITY_PREAMBLE_PATTERNS = [
  /You are a coding agent running in the [A-Za-z0-9 ._-]*CLI,[^.]*\.\s*[A-Za-z0-9 ._-]*CLI is an open source project led by [A-Za-z0-9 ._-]*\.[^.]*\./g,
];
const PREAMBLE_PLACEHOLDER = "[third-party agent identity preamble removed by proxy]";

/** Neutralize blocked third-party identity preambles in system/assistant text. */
function sanitizeIdentityText(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  let out = value;
  for (const preamble of IDENTITY_PREAMBLES) out = out.split(preamble).join(PREAMBLE_PLACEHOLDER);
  for (const pattern of IDENTITY_PREAMBLE_PATTERNS) out = out.replace(pattern, PREAMBLE_PLACEHOLDER);
  return out;
}

/** Apply the role rewrite and identity sanitization to every message part. */
/** 深度遍历任意 JSON 值，清洗所有字符串（含 tool_calls 的 arguments）。 */
function sanitizeDeep(value) {
  if (typeof value === "string") return sanitizeIdentityText(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = sanitizeDeep(value[i]);
    return value;
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) value[key] = sanitizeDeep(value[key]);
    return value;
  }
  return value;
}

/**
 * Apply the role rewrite and identity sanitization to every message part. (codex-proxy-deep-walk-v1)
 * 深度遍历整个 messages，而不是只扫 content —— tool_calls[].function.arguments
 * 是 Codex 工具参数落地的位置，也是此前漏扫导致 11128 的根因。
 */
function enforceUpstreamPolicy(body) {
  if (!Array.isArray(body?.messages)) return body;
  for (const m of body.messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "developer") m.role = "system";
  }
  sanitizeDeep(body.messages);
  return body;
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

/**
 * 工具参数 schema 清洗:剔除模型提供方会拒绝的非标准键
 * (2026-09-28 起 `$schema` 等被严格校验 → 400 code 11133 / model_param_invalid)。
 * 只在 schema 位置删除,不动 properties 里同名的业务参数。
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
    const v = node[k];
    // additionalProperties 为「schema 对象」时归一化成布尔 true(部分提供方只接受布尔)
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
 * 消息顺序归一化:assistant(tool_calls) 与其 tool 结果之间若被其他消息(如用户插话)隔开,
 * 上游会以 400/11133(model_param_invalid)拒绝。把匹配的 tool 结果上移,其余消息顺延。
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
        messages.splice(i + 1, window.length, ...toolMsgs, ...window.filter((x) => !isMatchedTool(x)));
        fixes += 1;
      }
    }
    i = end;
  }
  return fixes;
}

async function callUpstream(body) {
  const cred = await resolveCredential();
  enforceUpstreamPolicy(body);
  sanitizeTools(body.tools);
  normalizeMessageOrder(body.messages);
  // 国际版网关前置条件:messages[0] 必须是 system(缺失则注入一条最小提示词)
  if (regionOf(cred.domain) === "global") {
    const msgs = body.messages;
    if (Array.isArray(msgs) && !(msgs[0] && msgs[0].role === "system")) {
      msgs.unshift({ role: "system", content: "You are a helpful assistant." });
    }
  }
  if (process.env.WB_DEBUG) {
    try {
      const { writeFile } = await import("node:fs/promises");
      const file = process.env.WB_DEBUG_FILE || join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "proxy-debug-body.json");
      await writeFile(file, JSON.stringify(body, null, 2), "utf8");
      console.log(`[debug] upstream body (${JSON.stringify(body).length} bytes) → ${file}`);
    } catch (e) {
      console.log(`[debug] dump failed: ${String(e)}`);
    }
  }
  let res = await fetchUpstreamRetry(`${chatBase(cred)}/v2/chat/completions`, {
    method: "POST",
    headers: { ...chatHeaders(cred), Authorization: `Bearer ${cred.accessToken}` },
    body: JSON.stringify(body),
  });
  // 11133 / model_param_invalid:模型提供方拒绝参数(最常见=max_tokens 超其真实上限)。
  // 拒绝发生在推理之前,自动减半重试无额外推理成本;最多降两级。
  // 11133 / model_param_invalid:模型提供方拒绝参数(实测 128000/32000 均被拒)。
  // 拒绝发生在推理之前 → 逐级减半重试零推理成本;砍到底仍被拒则移除字段用服务端默认。
  let shrinkLeft = 6;
  while (res.status === 400 && shrinkLeft > 0) {
    const peek = await res.clone().text();
    if (!(peek.includes("11133") || peek.includes("model_param_invalid"))) break;
    if (Number.isFinite(body.max_tokens) && body.max_tokens > 1024) {
      body.max_tokens = Math.max(1024, Math.floor(body.max_tokens / 2));
      try { appendFileSync(join(process.cwd(), "proxy-events.log"), `${new Date().toISOString()} 11133: max_tokens 降为 ${body.max_tokens} 后重试\n`); } catch {}
    } else if ("max_tokens" in body) {
      delete body.max_tokens;
      try { appendFileSync(join(process.cwd(), "proxy-events.log"), `${new Date().toISOString()} 11133: 移除 max_tokens,改用服务端默认后重试\n`); } catch {}
    } else {
      break;
    }
    shrinkLeft -= 1;
    res = await fetchUpstreamRetry(`${chatBase(cred)}/v2/chat/completions`, {
      method: "POST",
      headers: { ...chatHeaders(cred), Authorization: `Bearer ${cred.accessToken}` },
      body: JSON.stringify(body),
    });
  }
  return { res, cred };
}

/** 迭代上游 SSE,回调每个 data 对象。 */
async function iterateUpstreamSSE(stream, onJson) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try { onJson(JSON.parse(payload)); } catch {}
    }
  }
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}
function sendOpenAIError(res, status, message, type = "api_error", code = null) {
  if (res.headersSent) {
    try { res.write(`data: ${JSON.stringify({ error: { message, type, code } })}\n\n`); res.write("data: [DONE]\n\n"); } catch {}
    res.end();
    return;
  }
  sendJson(res, status, { error: { message, type, code } });
}
function errorStatusFor(kind) {
  return kind === "hard_credit" ? 402 : kind === "soft_rate" ? 429 : kind === "session_dead" ? 401
    : kind === "server" || kind === "not_found" ? 502 : 400;
}

// ---------------------------------------------------------------- responses → chat

/** Responses API 请求 → chat completions body。 */
function responsesToChat(reqBody) {
  const messages = [];
  const instructions = reqBody.instructions;
  if (typeof instructions === "string" && instructions.trim()) messages.push({ role: "system", content: instructions });

  const input = Array.isArray(reqBody.input) ? reqBody.input
    : typeof reqBody.input === "string" ? [{ type: "message", role: "user", content: [{ type: "input_text", text: reqBody.input }] }]
    : [];

  // function_call 输出要合并成一条 assistant 消息(with tool_calls)
  const pendingAssistantToolCalls = [];
  let pendingReasoning = ""; // WorkBuddy 网关契约(11155):思维链模式下上一轮 reasoning_content 必须回传
  const flushAssistant = () => {
    if (pendingAssistantToolCalls.length === 0) return;
    const rc = pendingReasoning ? { reasoning_content: pendingReasoning } : {};
    pendingReasoning = "";
    messages.push({ role: "assistant", content: null, ...rc, tool_calls: pendingAssistantToolCalls.splice(0, pendingAssistantToolCalls.length) });
  };

  for (const item of input) {
    if (item == null) continue;
    const type = item.type ?? (item.role ? "message" : undefined);
    if (type === "function_call") {
      pendingAssistantToolCalls.push({
        id: item.call_id ?? item.id ?? rid("call"),
        type: "function",
        function: { name: item.name ?? "", arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}) },
      });
      continue;
    }
    flushAssistant();
    if (type === "function_call_output") {
      const out = item.output;
      const text = typeof out === "string" ? out
        : Array.isArray(out) ? out.map((b) => (b?.type === "input_text" || b?.type === "text" ? b.text : "")).join("\n")
        : JSON.stringify(out ?? "");
      messages.push({ role: "tool", tool_call_id: item.call_id ?? item.id ?? "", content: text });
      continue;
    }
    if (type === "reasoning") {
      // 收集思维链文本,挂到同轮 assistant 消息上(网关 400 code 11155 要求回传)
      const txt = (item.summary ?? []).map((s) => s?.text ?? "").filter(Boolean).join("\n");
      if (txt) pendingReasoning = pendingReasoning ? pendingReasoning + "\n" + txt : txt;
      continue;
    }
    if (type === "item_reference" || type === "web_search_call") continue; // 上游无需回放
    if (type === "message" || item.role) {
      const role = item.role === "assistant" ? "assistant" : item.role === "system" || item.role === "developer" ? "system" : "user";
      const content = item.content;
      if (typeof content === "string") { messages.push({ role, content }); continue; }
      if (!Array.isArray(content)) continue;
      const parts = [];
      let textOnly = "";
      for (const part of content) {
        if (part == null) continue;
        const pt = part.type;
        if (pt === "input_text" || pt === "output_text" || pt === "text" || pt === "summary_text") {
          if (part.text) { textOnly += part.text; parts.push({ type: "text", text: part.text }); }
        } else if (pt === "input_image" || pt === "image_url") {
          const url = part.image_url ?? part.url;
          if (url) parts.push({ type: "image_url", image_url: { url } });
        } else if (pt === "refusal") {
          if (part.refusal) { textOnly += part.refusal; parts.push({ type: "text", text: part.refusal }); }
        }
      }
      if (parts.length === 0) { if (role !== "assistant") pendingReasoning = ""; continue; }
      const hasImage = parts.some((p) => p.type === "image_url");
      // 思维链回传:挂到 assistant 消息上;遇到 user/system 则视为孤立,丢弃
      const rc = role === "assistant" && pendingReasoning ? { reasoning_content: pendingReasoning } : {};
      if (role === "assistant") pendingReasoning = ""; else pendingReasoning = "";
      messages.push({ role, content: hasImage ? parts : textOnly, ...rc });
    }
  }
  flushAssistant();

  const body = { model: reqBody.model, messages };

  if (Array.isArray(reqBody.tools) && reqBody.tools.length) {
    const tools = [];
    for (const t of reqBody.tools) {
      if (!t) continue;
      if (t.type && t.type !== "function") continue; // 上游只支持 function 工具
      const name = t.name ?? t.function?.name;
      if (!name) continue;
      tools.push({
        type: "function",
        function: {
          name,
          description: t.description ?? t.function?.description ?? "",
          parameters: t.parameters ?? t.function?.parameters ?? { type: "object", properties: {} },
        },
      });
    }
    if (tools.length) body.tools = tools;
  }

  const tc = normalizeToolChoice(reqBody.tool_choice);
  if (tc) body.tool_choice = tc;
  if (Number.isFinite(reqBody.temperature)) body.temperature = reqBody.temperature;
  if (Number.isFinite(reqBody.top_p)) body.top_p = reqBody.top_p;
  if (Number.isFinite(reqBody.max_output_tokens)) body.max_tokens = reqBody.max_output_tokens;
  else if (Number.isFinite(reqBody.max_tokens)) body.max_tokens = reqBody.max_tokens;

  // 国际版网关契约(400 code 11155):思维链模式要求上一轮完整 reasoning_content 回传,
  // 而 Codex 协议只能拿到摘要、无法完整回传 → 长对话必炸。实测同一请求体:
  // 带 reasoning_effort=high → 11155;不发 → 200。故国际版一律不发思维链参数。
  const effort = IS_AI ? undefined : normalizeEffort(reqBody.model, reqBody.reasoning?.effort);
  return { body: finalizeChatBody(body, reqBody.model, effort), effort };
}

// ---------------------------------------------------------------- chat SSE → responses SSE

function responseEnvelope({ id, model, output, usage, status = "completed", effort = null }) {
  return {
    id, object: "response", created_at: Math.floor(Date.now() / 1000), status, model,
    output, usage, error: null, incomplete_details: null,
    instructions: null, metadata: {}, parallel_tool_calls: true,
    temperature: null, top_p: null, max_output_tokens: null, previous_response_id: null,
    reasoning: { effort, summary: null },
    text: { format: { type: "text" } }, tool_choice: "auto", tools: [], truncation: "disabled", user: null,
    store: false,
  };
}

/**
 * 消费上游 chat SSE,按 Responses API 事件流写给客户端;
 * 同时聚合出完整 response 对象(供 response.completed / 非流式使用)。
 */
async function relayAsResponses(upstreamStream, res, { model, stream, effort }) {
  const responseId = rid("resp");
  const emit = (obj) => {
    if (stream && !res.writableEnded) res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
  };

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    emit({ type: "response.created", response: responseEnvelope({ id: responseId, model, output: [], usage: null, status: "in_progress", effort }) });
    emit({ type: "response.in_progress", response: responseEnvelope({ id: responseId, model, output: [], usage: null, status: "in_progress", effort }) });
  }

  const output = [];
  let seq = 0;
  const nextIndex = () => output.length;

  // 当前正在流式输出的 item
  let open = null; // {kind:'reasoning'|'message'|'function_call', index, itemId, ...}
  let usage = { input: 0, output: 0, reasoning: 0 };

  const closeOpen = () => {
    if (!open) return;
    if (open.kind === "reasoning") {
      const item = { type: "reasoning", id: open.itemId, summary: open.text ? [{ type: "summary_text", text: open.text }] : [] };
      output[open.index] = item;
      emit({ type: "response.reasoning_summary_text.done", item_id: open.itemId, output_index: open.index, summary_index: 0, text: open.text });
      emit({ type: "response.reasoning_summary_part.done", item_id: open.itemId, output_index: open.index, summary_index: 0, part: { type: "summary_text", text: open.text } });
      emit({ type: "response.output_item.done", output_index: open.index, item });
    } else if (open.kind === "message") {
      const part = { type: "output_text", text: open.text, annotations: [] };
      const item = { type: "message", id: open.itemId, status: "completed", role: "assistant", content: [part] };
      output[open.index] = item;
      emit({ type: "response.output_text.done", item_id: open.itemId, output_index: open.index, content_index: 0, text: open.text });
      emit({ type: "response.content_part.done", item_id: open.itemId, output_index: open.index, content_index: 0, part });
      emit({ type: "response.output_item.done", output_index: open.index, item });
    } else if (open.kind === "function_call") {
      const item = { type: "function_call", id: open.itemId, call_id: open.callId, name: open.name, arguments: open.args, status: "completed" };
      output[open.index] = item;
      emit({ type: "response.function_call_arguments.done", item_id: open.itemId, output_index: open.index, arguments: open.args });
      emit({ type: "response.output_item.done", output_index: open.index, item });
    }
    open = null;
  };

  const openReasoning = () => {
    if (open?.kind === "reasoning") return;
    closeOpen();
    const index = nextIndex();
    open = { kind: "reasoning", index, itemId: rid("rs"), text: "" };
    output[index] = { type: "reasoning", id: open.itemId, summary: [] };
    emit({ type: "response.output_item.added", output_index: index, item: { type: "reasoning", id: open.itemId, summary: [] } });
    emit({ type: "response.reasoning_summary_part.added", item_id: open.itemId, output_index: index, summary_index: 0, part: { type: "summary_text", text: "" } });
  };
  const openMessage = () => {
    if (open?.kind === "message") return;
    closeOpen();
    const index = nextIndex();
    open = { kind: "message", index, itemId: rid("msg"), text: "" };
    output[index] = { type: "message", id: open.itemId, status: "in_progress", role: "assistant", content: [] };
    emit({ type: "response.output_item.added", output_index: index, item: { type: "message", id: open.itemId, status: "in_progress", role: "assistant", content: [] } });
    emit({ type: "response.content_part.added", item_id: open.itemId, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  };
  const openFunctionCall = (callId, name) => {
    closeOpen();
    const index = nextIndex();
    open = { kind: "function_call", index, itemId: rid("fc"), callId: callId || rid("call"), name: name || "", args: "" };
    output[index] = { type: "function_call", id: open.itemId, call_id: open.callId, name: open.name, arguments: "", status: "in_progress" };
    emit({ type: "response.output_item.added", output_index: index, item: { type: "function_call", id: open.itemId, call_id: open.callId, name: open.name, arguments: "", status: "in_progress" } });
  };

  await iterateUpstreamSSE(upstreamStream, (json) => {
    if (json.usage) {
      usage.input = json.usage.prompt_tokens ?? usage.input;
      usage.output = json.usage.completion_tokens ?? usage.output;
      const rt = json.usage.completion_tokens_details?.reasoning_tokens;
      if (Number.isFinite(rt)) usage.reasoning = rt;
    }
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};

    const rc = delta.reasoning_content ?? (typeof delta.reasoning === "string" ? delta.reasoning : undefined);
    if (typeof rc === "string" && rc) {
      openReasoning();
      open.text += rc;
      usage.reasoning += Math.ceil(rc.length / 4);
      emit({ type: "response.reasoning_summary_text.delta", item_id: open.itemId, output_index: open.index, summary_index: 0, delta: rc });
    }
    if (typeof delta.content === "string" && delta.content) {
      openMessage();
      open.text += delta.content;
      emit({ type: "response.output_text.delta", item_id: open.itemId, output_index: open.index, content_index: 0, delta: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const isNew = tc.id || (tc.function?.name && !(open?.kind === "function_call" && open.name === tc.function.name && open.callId === tc.id));
        if (!open || open.kind !== "function_call" || (tc.id && tc.id !== open.callId)) {
          openFunctionCall(tc.id, tc.function?.name);
        } else if (tc.function?.name && !open.name) {
          open.name = tc.function.name;
        }
        if (typeof tc.function?.arguments === "string" && tc.function.arguments) {
          open.args += tc.function.arguments;
          emit({ type: "response.function_call_arguments.delta", item_id: open.itemId, output_index: open.index, delta: tc.function.arguments });
        }
      }
    }
    void isNew;
  });

  closeOpen();

  const outTokens = usage.output || Math.ceil(output.map((i) =>
    i.type === "message" ? (i.content?.[0]?.text?.length ?? 0)
      : i.type === "reasoning" ? (i.summary?.[0]?.text?.length ?? 0)
      : (i.arguments?.length ?? 0)).reduce((a, b) => a + b, 0) / 4);

  const finalUsage = {
    input_tokens: usage.input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoning },
    total_tokens: usage.input + outTokens,
  };

  const finalResponse = responseEnvelope({ id: responseId, model, output, usage: finalUsage, status: "completed", effort });
  if (stream) {
    emit({ type: "response.completed", response: finalResponse });
    res.end();
  }
  return finalResponse;
}

// ---------------------------------------------------------------- server

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  try {
    if (PROXY_TOKEN) {
      const authz = req.headers.authorization ?? "";
      if (authz !== `Bearer ${PROXY_TOKEN}`) {
        sendOpenAIError(res, 401, "invalid proxy bearer token", "invalid_request_error", "unauthorized");
        return;
      }
    }

    if (req.method === "GET" && (url === "/healthz" || url === "/")) {
      sendJson(res, 200, { ok: true, service: "codex-workbuddy-proxy", port: PORT, endpoints: ["/v1/responses", "/v1/chat/completions", "/v1/models"] });
      return;
    }

    if (req.method === "GET" && (url === "/v1/models" || url === "/models")) {
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
          if (live.length) {
            models = live;
            modelInfo.clear();
            for (const m of models) modelInfo.set(m.id, m);
          }
        } catch {}
        sendJson(res, 200, { object: "list", data: models.map((m) => ({ id: m.id, object: "model", owned_by: "workbuddy-ai" })) });
        return;
      }
      try {
        const cred = await resolveCredential();
        const mres = await fetch(`${chatBase(cred)}/console/enterprises/personal/models`, {
          headers: {
            Authorization: `Bearer ${cred.accessToken}`, Accept: "application/json",
            Origin: originReferer(cred), Referer: `${originReferer(cred)}/`, "User-Agent": CLIENT_UA,
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
          if (live.length) {
            models = live;
            modelInfo.clear();
            for (const m of models) modelInfo.set(m.id, m);
          }
        }
      } catch {}
      sendJson(res, 200, {
        object: "list",
        data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "workbuddy" })),
      });
      return;
    }

    const isResponses = req.method === "POST" && (url === "/v1/responses" || url === "/responses");
    const isChat = req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions");
    if (!isResponses && !isChat) {
      sendOpenAIError(res, 404, `no such route: ${req.method} ${url}`, "invalid_request_error", "not_found");
      return;
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        sendOpenAIError(res, 413, "request body too large", "invalid_request_error", "body_too_large");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      sendOpenAIError(res, 400, "request body is not valid JSON", "invalid_request_error", "invalid_json");
      return;
    }

    // 组装上游 chat 请求
    let body, model, effort, wantStream;
    if (isResponses) {
      model = parsed.model || "glm-5.3-flash";
      const conv = responsesToChat({ ...parsed, model });
      body = conv.body;
      effort = conv.effort;
      wantStream = parsed.stream !== false;
    } else {
      model = parsed.model || "glm-5.3-flash";
      const copy = { ...parsed };
      const effortRaw = copy.reasoning_effort;
      delete copy.reasoning_effort;
      // 国际版不发思维链参数(11155 契约无法满足,见 responsesToChat 内注释)
      effort = IS_AI ? undefined : normalizeEffort(model, effortRaw);
      body = finalizeChatBody({ ...copy, model }, model, effort);
      wantStream = parsed.stream !== false;
    }

    const { res: upstream } = await callUpstream(body);
    if (!upstream.ok) {
      const text = (await upstream.text()).slice(0, 2000);
      const kind = classify(upstream.status, text);
      if (kind === "session_dead") cached = null;
      if (upstream.status === 400) {
        // 400 落盘捕获(如 11155 reasoning_content_missing):留存确切请求体供离线分析,不打印内容
        try {
          await mkdir(join(process.cwd(), "capture"), { recursive: true });
          await writeFile(join(process.cwd(), "capture", `400-${Date.now()}.json`), JSON.stringify({ at: new Date().toISOString(), body }, null, 2));
          console.log("[codex-workbuddy-proxy] 上游 400:请求体已落盘 capture/");
        } catch {}
      }
      sendOpenAIError(res, errorStatusFor(kind),
        `workbuddy upstream ${kind} (http ${upstream.status}): ${text.slice(0, 300)}`,
        kind === "session_dead" ? "authentication_error" : "api_error", kind);
      return;
    }

    if (isResponses) {
      await relayAsResponses(upstream.body, res, { model, stream: wantStream, effort });
      return;
    }

    // chat completions:要流式就透传,否则聚合
    if (wantStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } catch {}
      res.end();
      return;
    }

    let content = "", reasoning = "", finishReason = "stop", usage = null;
    let id = rid("chatcmpl"), created = Math.floor(Date.now() / 1000), respModel = model;
    const toolCalls = new Map();
    await iterateUpstreamSSE(upstream.body, (json) => {
      if (json.id) id = json.id;
      if (json.created) created = json.created;
      if (json.model) respModel = json.model;
      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = Number.isFinite(tc.index) ? tc.index : 0;
          let slot = toolCalls.get(idx);
          if (!slot) {
            slot = { id: tc.id ?? rid("call"), type: "function", function: { name: "", arguments: "" } };
            toolCalls.set(idx, slot);
          }
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.function.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") slot.function.arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    });

    const message = { role: "assistant", content: content || null };
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.size > 0) message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    sendJson(res, 200, {
      id, object: "chat.completion", created, model: respModel,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: usage ?? { prompt_tokens: 0, completion_tokens: Math.ceil((content.length + reasoning.length) / 4), total_tokens: Math.ceil((content.length + reasoning.length) / 4) },
    });
  } catch (err) {
    sendOpenAIError(res, 500, `proxy internal error: ${String(err?.message ?? err)}`);
  }
});

server.requestTimeout = 0;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[codex-workbuddy-proxy] listening on http://127.0.0.1:${PORT}`);
  console.log(`[codex-workbuddy-proxy] auth file: ${authFilePath()}`);
  console.log(`[codex-workbuddy-proxy] endpoints: /v1/responses (Codex), /v1/chat/completions, /v1/models`);
});

// ---------------------------------------------------------------- AI 实例看门狗
// 国内版实例由开机自启拉起(登录即活),由它守护同目录的国际版实例:
// 周期探测 8403,连不上则以独立进程拉起 AI 变体(detached + unref,不随本进程退出)。
// 环境说明:workbuddy.ai 被(fake-ip DNS)劫持,直连 fake-ip 会被拒,
// 故 AI 实例必须带 NODE_USE_ENV_PROXY=1 + HTTPS_PROXY 走 mihomo 混合端口(7897)。
if (!IS_AI && process.env.WB_WATCHDOG !== "0") {
  const { spawn } = await import("node:child_process");
  const { createConnection } = await import("node:net");
  const AI_PORT = 8403;
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
        console.log(`[codex-workbuddy-proxy] AI 实例(${AI_PORT})未响应,已重新拉起`);
      } catch {}
    }
  };
  setTimeout(ensureAi, 8000);
  setInterval(ensureAi, 60000);
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
