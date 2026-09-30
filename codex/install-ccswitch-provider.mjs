#!/usr/bin/env node
/**
 * 把 WorkBuddy 注册成 Codex 的一个 provider（写进 cc-switch 数据库）
 * ================================================================
 *
 * 背景：codex-workbuddy-proxy 本身是好的（/v1/models、/v1/chat/completions
 *      非流式/流式+工具调用/tool_result 回环 全 200），缺的是「接进 Codex」这一步。
 *      Codex 侧由 cc-switch 管理 provider，zcode 侧已有同类 provider，
 *      但 codex 侧一直没有 —— 本脚本补上。
 *
 * 做法：
 *   1. 备份 cc-switch.db
 *   2. 以你**当前** ~/.codex/config.toml 为模板（保留 plugins / projects /
 *      mcp_servers / notify 等），只替换 model 与 [model_providers.custom] 的
 *      name / base_url，作为新 provider 的 config
 *   3. 写入 providers 表（app_type='codex', id='codex-workbuddy-proxy'）
 *   4. 不抢占 is_current —— 由你在 cc-switch 界面里手动切换
 *
 * 用法：
 *   node install-ccswitch-provider.mjs [--model <id>] [--dry-run] [--remove]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PROVIDER_ID = 'codex-workbuddy-proxy';
const APP_TYPE = 'codex';
const PROXY_BASE = 'http://127.0.0.1:8401/v1';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const defaultModel = opt('--model', 'glm-5.3-flash');
const dryRun = has('--dry-run');
const remove = has('--remove');

const DB = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
const CODEX_CONFIG = path.join(os.homedir(), '.codex', 'config.toml');

/* 上游模型目录（抄自 codex-workbuddy-proxy 的 FALLBACK_MODELS，含上下文窗口） */
const MODELS = [
	{ id: 'auto', ctx: 168_000, name: 'Auto' },
	{ id: 'hy4-preview', ctx: 1_000_000, name: 'Hy4 Preview（限时免费）' },
	{ id: 'hy3', ctx: 192_000, name: 'Hy3（限时免费）' },
	{ id: 'hy3-x', ctx: 192_000, name: 'Hy3-X' },
	{ id: 'glm-5.3', ctx: 1_000_000, name: 'GLM-5.3' },
	{ id: 'glm-5.3-flash', ctx: 1_000_000, name: 'GLM-5.3-Flash' },
	{ id: 'glm-5.2', ctx: 1_000_000, name: 'GLM-5.2' },
	{ id: 'glm-5.1', ctx: 200_000, name: 'GLM-5.1' },
	{ id: 'glm-5v-turbo', ctx: 200_000, name: 'GLM-5V-Turbo' },
	{ id: 'kimi-k3-1', ctx: 1_000_000, name: 'Kimi-K3' },
	{ id: 'kimi-k2.7', ctx: 256_000, name: 'Kimi-K2.7' },
	{ id: 'kimi-k2.6', ctx: 256_000, name: 'Kimi-K2.6' },
	{ id: 'minimax-m3', ctx: 512_000, name: 'MiniMax-M3' },
	{ id: 'deepseek-v4-flash', ctx: 1_000_000, name: 'DeepSeek-V4-Flash' },
	{ id: 'deepseek-v4-pro', ctx: 1_000_000, name: 'DeepSeek-V4-Pro' },
];

if (!fs.existsSync(DB)) {
	console.error(`[install] ❌ 找不到 cc-switch 数据库：${DB}`);
	process.exit(2);
}

const db = new DatabaseSync(DB);

/* ---------------- --remove ---------------- */
if (remove) {
	db.prepare(`DELETE FROM providers WHERE id = ? AND app_type = ?`).run(PROVIDER_ID, APP_TYPE);
	console.log(`[install] ✅ 已移除 provider ${PROVIDER_ID}`);
	process.exit(0);
}

/* ---------------- 用当前 config.toml 当模板 ---------------- */
if (!fs.existsSync(CODEX_CONFIG)) {
	console.error(`[install] ❌ 找不到 ${CODEX_CONFIG}（先让 Codex 正常跑一次生成它）`);
	process.exit(2);
}
let toml = fs.readFileSync(CODEX_CONFIG, 'utf8');

const before = toml;
toml = toml.replace(/^model\s*=\s*".*?"\s*$/mu, `model = "${defaultModel}"`);
toml = toml.replace(/^name\s*=\s*".*?"\s*$/mu, `name = "workbuddy"`);
toml = toml.replace(/^base_url\s*=\s*".*?"\s*$/mu, `base_url = "${PROXY_BASE}"`);
if (!/^wire_api\s*=/mu.test(toml)) toml = toml.replace(/^(base_url\s*=.*)$/mu, `$1\nwire_api = "responses"`);
if (!/^requires_openai_auth\s*=/mu.test(toml)) toml = toml.replace(/^(wire_api\s*=.*)$/mu, `$1\nrequires_openai_auth = true`);
if (!/^model_provider\s*=/mu.test(toml)) toml = `model_provider = "custom"\n` + toml;
if (!/^model_reasoning_effort\s*=/mu.test(toml)) toml = toml.replace(/^(model\s*=.*)$/mu, `$1\nmodel_reasoning_effort = "high"`);

const changed = before !== toml;
const settings = {
	auth: { OPENAI_API_KEY: 'workbuddy-local-proxy' },
	config: toml,
	modelCatalog: {
		models: MODELS.map((m) => ({ model: m.id, displayName: m.name, contextWindow: m.ctx })),
	},
};

console.log('========================================');
console.log(' 注册 WorkBuddy 为 Codex provider');
console.log('========================================');
console.log(` cc-switch DB : ${DB}`);
console.log(` 配置模板     : ${CODEX_CONFIG}`);
console.log(` provider id  : ${PROVIDER_ID}`);
console.log(` base_url     : ${PROXY_BASE}`);
console.log(` 默认 model   : ${defaultModel}`);
console.log(` 目录模型数   : ${MODELS.length}`);
console.log(` config 是否改动: ${changed ? '是' : '否（模板已符合）'}`);
console.log('');
console.log('----- 将要写入的 config -----');
console.log(toml.split('\n').filter((l) => /^(model|model_provider|model_reasoning_effort|name|base_url|wire_api|requires_openai_auth|disable_response_storage|model_catalog_json)\s*=/u.test(l)).join('\n'));
console.log('-----------------------------');

if (dryRun) {
	console.log('\n[install] --dry-run：未写库。');
	process.exit(0);
}

/* ---------------- 备份 ---------------- */
const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);
const backup = `${DB}.bak-workbuddy-${stamp}`;
fs.copyFileSync(DB, backup);
console.log(`\n[install] 已备份 → ${path.basename(backup)}`);

/* ---------------- 写入 ---------------- */
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
	'WorkBuddy',
	JSON.stringify(settings),
	'https://www.codebuddy.cn',
	null,
	Date.now(),
	null, // sort_index 必须为 NULL 或非负整数：cc-switch 是 Rust 实现，
	//        写成 -1 会触发 "Integer -1 out of range at index 6"，
	//        导致读取 provider 列表失败、应用直接打不开。已踩过这个坑。
	meta
);

const row = db.prepare(`SELECT id, name, is_current FROM providers WHERE id = ? AND app_type = ?`).get(PROVIDER_ID, APP_TYPE);
console.log(`[install] ✅ 已写入：id=${row.id} name=${row.name} is_current=${row.is_current}`);
console.log('');
console.log('  下一步：');
console.log('    1) 打开 cc-switch，切到 "WorkBuddy"（它不会自动抢当前 provider）');
console.log('    2) 确保代理在跑：powershell -File proxy.ps1 start');
console.log('    3) 重启 Codex，随便发一句话验证');
console.log('');
console.log(`  回滚：node install-ccswitch-provider.mjs --remove`);
console.log(`        或直接还原 ${path.basename(backup)}`);
