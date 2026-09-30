#!/usr/bin/env node
/**
 * 把国际版 WorkBuddy AI 注册成 Codex 的第二个 provider（写进 cc-switch 数据库）
 * ==================================================================
 * 与 install-ccswitch-provider.mjs 同套路，区别只有：
 *   provider id : codex-workbuddy-ai-proxy
 *   base_url    : http://127.0.0.1:8403/v1   （国际版反代）
 *   模型目录    : 国际版 20 个模型
 *
 * 用法：node install-ccswitch-provider-ai.mjs [--model <id>] [--dry-run] [--remove]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PROVIDER_ID = 'codex-workbuddy-ai-proxy';
const APP_TYPE = 'codex';
const PROXY_BASE = 'http://127.0.0.1:8403/v1';
const DISPLAY_NAME = 'WorkBuddy AI';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const defaultModel = opt('--model', 'default-model');
const dryRun = has('--dry-run');
const remove = has('--remove');

const DB = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
const CODEX_CONFIG = path.join(os.homedir(), '.codex', 'config.toml');
const AI_CATALOG = path.join(os.homedir(), '.dsh', '.workbuddy-ai-catalog.json');

/* 国际版模型目录:优先读插件缓存,失败则用内置兜底 */
let MODELS = [];
try {
  const doc = JSON.parse(fs.readFileSync(AI_CATALOG, 'utf8'));
  const entry = Object.values(doc.entries ?? {})[0];
  MODELS = (entry?.models ?? []).map((m) => ({ id: m.id, ctx: Number(m.contextWindow) || 200_000, name: m.name ?? m.id }));
} catch {}
if (!MODELS.length) {
  MODELS = ['default-model', 'fast-model', 'balanced-model', 'primary-model', 'deep-model', 'hy4-preview-f', 'hy3',
    'deepseek-v4.1-flash', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4',
    'gpt-5.3-codex', 'gemini-3.5-flash', 'glm-5.3', 'glm-5.2', 'kimi-k3', 'kimi-k2.6']
    .map((id) => ({ id, ctx: 200_000, name: id }));
}

if (!fs.existsSync(DB)) { console.error(`[install-ai] ❌ 找不到 cc-switch 数据库：${DB}`); process.exit(2); }
const db = new DatabaseSync(DB);

if (remove) {
  db.prepare(`DELETE FROM providers WHERE id = ? AND app_type = ?`).run(PROVIDER_ID, APP_TYPE);
  console.log(`[install-ai] ✅ 已移除 provider ${PROVIDER_ID}`);
  process.exit(0);
}

if (!fs.existsSync(CODEX_CONFIG)) { console.error(`[install-ai] ❌ 找不到 ${CODEX_CONFIG}`); process.exit(2); }
let toml = fs.readFileSync(CODEX_CONFIG, 'utf8');
const before = toml;
toml = toml.replace(/^model\s*=\s*".*?"\s*$/mu, `model = "${defaultModel}"`);
toml = toml.replace(/^name\s*=\s*".*?"\s*$/mu, `name = "workbuddy-ai"`);
toml = toml.replace(/^base_url\s*=\s*".*?"\s*$/mu, `base_url = "${PROXY_BASE}"`);
if (!/^wire_api\s*=/mu.test(toml)) toml = toml.replace(/^(base_url\s*=.*)$/mu, `$1\nwire_api = "responses"`);
if (!/^requires_openai_auth\s*=/mu.test(toml)) toml = toml.replace(/^(wire_api\s*=.*)$/mu, `$1\nrequires_openai_auth = true`);
if (!/^model_provider\s*=/mu.test(toml)) toml = `model_provider = "custom"\n` + toml;
if (!/^model_reasoning_effort\s*=/mu.test(toml)) toml = toml.replace(/^(model\s*=.*)$/mu, `$1\nmodel_reasoning_effort = "high"`);

const settings = {
  auth: { OPENAI_API_KEY: 'workbuddy-local-proxy' },
  config: toml,
  modelCatalog: { models: MODELS.map((m) => ({ model: m.id, displayName: m.name, contextWindow: m.ctx })) },
};

console.log('========================================');
console.log(' 注册 国际版 WorkBuddy AI 为 Codex provider');
console.log('========================================');
console.log(` cc-switch DB : ${DB}`);
console.log(` provider id  : ${PROVIDER_ID}  （${DISPLAY_NAME}）`);
console.log(` base_url     : ${PROXY_BASE}`);
console.log(` 默认 model   : ${defaultModel}`);
console.log(` 目录模型数   : ${MODELS.length}`);
console.log(` config 模板改动: ${before !== toml ? '是' : '否'}`);

if (dryRun) { console.log('\n[install-ai] --dry-run：未写库。'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);
const backup = `${DB}.bak-workbuddy-ai-${stamp}`;
fs.copyFileSync(DB, backup);
console.log(`\n[install-ai] 已备份 → ${path.basename(backup)}`);

const meta = JSON.stringify({ commonConfigEnabled: false, endpointAutoSelect: true, apiFormat: 'openai_responses' });
db.prepare(`
	INSERT INTO providers (id, app_type, name, settings_config, website_url, category, created_at, sort_index, meta, is_current, in_failover_queue, cost_multiplier, provider_type)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '1.0', NULL)
	ON CONFLICT(id, app_type) DO UPDATE SET
		name = excluded.name,
		settings_config = excluded.settings_config,
		website_url = excluded.website_url,
		meta = excluded.meta
`).run(
  PROVIDER_ID,
  APP_TYPE,
  DISPLAY_NAME,
  JSON.stringify(settings),
  'https://www.workbuddy.ai',
  null,
  Date.now(),
  null, // sort_index 必须 NULL 或非负整数(Rust 实现,写 -1 会导致列表读取失败)
  meta
);

const row = db.prepare(`SELECT id, name, is_current FROM providers WHERE id = ? AND app_type = ?`).get(PROVIDER_ID, APP_TYPE);
console.log(`[install-ai] ✅ 已写入：id=${row.id} name=${row.name} is_current=${row.is_current}`);
console.log(`\n  下一步：打开 cc-switch 切到「${DISPLAY_NAME}」，重启 Codex 验证。`);
console.log(`  回滚：node install-ccswitch-provider-ai.mjs --remove`);
