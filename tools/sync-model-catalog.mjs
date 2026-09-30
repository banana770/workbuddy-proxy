#!/usr/bin/env node
/**
 * WorkBuddy 模型目录同步器
 * ========================
 * 上游（copilot.tencent.com）的 cli agent 模型列表会变（新增/下架），
 * 但三个下游都是**静态**的，不会自己跟着更新：
 *
 *   1. codex-workbuddy-proxy/proxy.mjs      的 FALLBACK_MODELS（兜底表）
 *   2. zcode-workbuddy-proxy/proxy.mjs      的 FALLBACK_MODELS（兜底表）
 *   3. cc-switch 里 codex provider 的         modelCatalog（Codex 读的就是它）
 *   4. ~/.zcode/v2/config.json 里              zcode-workbuddy-proxy.models
 *
 * 本脚本从上游实时拉取权威目录，然后把这四处一起更新。
 * WorkBuddy 再更新模型时，重跑一次即可。
 *
 * 用法：
 *   node sync-model-catalog.mjs [--dry-run] [--only codex|zcode|ccswitch|zcode-config]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';

/* ------------------------------------------------------------------ 常量 */

const CN_CHAT_BASE = 'https://copilot.tencent.com';
const GLOBAL_BASE = 'https://www.workbuddy.ai';
const CN_REFERER = 'https://www.codebuddy.cn';
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';

const WORKSPACE = path.resolve(import.meta.dirname, '..');
const CODEX_PROXY = path.join(WORKSPACE, 'codex-workbuddy-proxy', 'proxy.mjs');
const ZCODE_PROXY = path.join(WORKSPACE, 'zcode-workbuddy-proxy', 'proxy.mjs');
const CC_SWITCH_DB = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
const ZCODE_CONFIG = path.join(os.homedir(), '.zcode', 'v2', 'config.json');

const CC_PROVIDER_ID = 'codex-workbuddy-proxy';
const ZCODE_PROVIDER_ID = 'zcode-workbuddy-proxy';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const dryRun = has('--dry-run');
const only = opt('--only', 'all');
const want = (k) => only === 'all' || only === k;

const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);
const backups = [];
function backup(file) {
	if (!fs.existsSync(file)) return;
	const b = `${file}.bak-modelsync-${stamp}`;
	if (!dryRun) fs.copyFileSync(file, b);
	backups.push(b);
}

/* ------------------------------------------------------- 1. 拉上游权威目录 */

function firstExisting(paths) {
	for (const p of paths) if (p && fs.existsSync(p)) return p;
	return null;
}

const authPath = firstExisting([
	process.env.WORKBUDDY_AUTH_FILE,
	path.join(process.env.LOCALAPPDATA ?? '', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
	path.join(process.env.APPDATA ?? '', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
	path.join(os.homedir(), '.dsh', '.workbuddy-auth.json'),
	path.join(os.homedir(), '.zcode-workbuddy-proxy', 'auth.json'),
]);

if (!authPath) {
	console.error('[sync] ❌ 找不到 WorkBuddy 凭据文件，先在桌面 App 登录');
	process.exit(2);
}

const authDoc = JSON.parse(fs.readFileSync(authPath, 'utf8'));
const auth = typeof authDoc.auth === 'object' && authDoc.auth !== null ? authDoc.auth : authDoc;
const identity = typeof authDoc.account === 'object' && authDoc.account !== null ? authDoc.account : authDoc;
const cred = {
	accessToken: auth.accessToken ?? auth.credential?.accessToken,
	domain: auth.domain ?? auth.credential?.domain ?? '',
	uid: identity.uid ?? '',
	enterpriseId: identity.enterpriseId ?? '',
};
if (!cred.accessToken) {
	console.error('[sync] ❌ 凭据里没有 accessToken');
	process.exit(2);
}

const isGlobal = cred.domain === 'workbuddy.ai' || cred.domain.endsWith('.workbuddy.ai');
const base = isGlobal ? GLOBAL_BASE : CN_CHAT_BASE;
const referer = isGlobal ? GLOBAL_BASE : CN_REFERER;

const headers = {
	Authorization: `Bearer ${cred.accessToken}`,
	Accept: 'application/json',
	Origin: referer,
	Referer: `${referer}/`,
	'User-Agent': CLIENT_UA,
};
if (cred.uid) headers['X-User-Id'] = cred.uid;
if (cred.enterpriseId) headers['X-Enterprise-Id'] = cred.enterpriseId;
if (cred.domain) headers['X-Domain'] = cred.domain;

console.log('========================================');
console.log(' WorkBuddy 模型目录同步');
console.log('========================================');
console.log(` 凭据      : ${authPath}`);
console.log(` 上游      : ${base}`);
if (dryRun) console.log(' 模式      : --dry-run（不写任何文件）');
console.log('');

const res = await fetch(`${base}/console/enterprises/personal/models`, { headers, signal: AbortSignal.timeout(30_000) });
const body = await res.text();
if (!res.ok) {
	console.error(`[sync] ❌ 上游 HTTP ${res.status}: ${body.slice(0, 300)}`);
	process.exit(3);
}
let doc;
try { doc = JSON.parse(body); } catch { console.error('[sync] ❌ 上游返回非 JSON'); process.exit(3); }
if (doc.code !== 0) {
	console.error(`[sync] ❌ 上游 code=${doc.code} ${doc.msg ?? ''}`);
	process.exit(3);
}

const byId = new Map((doc.data?.models ?? []).map((m) => [m.id, m]));
const cliIds = (doc.data?.agents ?? []).find((a) => a.name === 'cli')?.models ?? [];
const RAW_BY_ID = byId;

const MODELS = [];
for (const id of cliIds) {
	const m = byId.get(id);
	if (!m || m.disabled === true) continue;
	MODELS.push({
		id: m.id,
		ctx: Number(m.maxInputTokens) || 200_000,
		out: Number(m.maxOutputTokens) || 32_000,
		img: m.supportsImages === true && m.disabledMultimodal !== true,
		efforts: Array.isArray(m.reasoning?.supportedEfforts) ? m.reasoning.supportedEfforts
			: typeof m.reasoning?.effort === 'string' ? [m.reasoning.effort] : undefined,
		canOff: m.reasoning?.canDisableThinking === true,
		displayName: m.displayName ?? m.name ?? m.id,
	});
}

if (MODELS.length === 0) {
	console.error('[sync] ❌ 上游 cli agent 没挂任何模型，中止（避免把好的配置清空）');
	process.exit(3);
}

console.log(` 拉到 ${MODELS.length} 个模型：`);
for (const m of MODELS) console.log(`   - ${m.id}  (ctx ${m.ctx}, out ${m.out}, img=${m.img ? 'Y' : 'n'})`);
console.log('');

/* --------------------------------------------------- 2. 生成 FALLBACK 代码 */

const num = (n) => n.toLocaleString('en-US').replaceAll(',', '_');
function fallbackCode(indent) {
	const pad = ' '.repeat(indent);
	const lines = MODELS.map((m) => {
		const eff = m.efforts === undefined ? 'undefined' : JSON.stringify(m.efforts);
		return `${pad}{ id: ${JSON.stringify(m.id)}, ctx: ${num(m.ctx)}, out: ${num(m.out)}, img: ${m.img}, efforts: ${eff}, canOff: ${m.canOff} },`;
	});
	return `const FALLBACK_MODELS = [\n${lines.join('\n')}\n];`;
}

function updateFallbackTable(file, label) {
	if (!fs.existsSync(file)) { console.log(`[sync] ⏭  ${label}: 文件不存在，跳过`); return; }
	const src = fs.readFileSync(file, 'utf8');
	const start = src.indexOf('const FALLBACK_MODELS = [');
	if (start < 0) { console.log(`[sync] ⏭  ${label}: 找不到 FALLBACK_MODELS，跳过`); return; }
	const endMarker = '\n];';
	const end = src.indexOf(endMarker, start);
	if (end < 0) { console.log(`[sync] ⏭  ${label}: FALLBACK_MODELS 结尾定位失败，跳过`); return; }

	const after = src.slice(start + 'const FALLBACK_MODELS = ['.length);
	const m = after.match(/\n(\s*)\{/u);
	const indent = m ? m[1].length : 2;

	const next = src.slice(0, start) + fallbackCode(indent) + src.slice(end + endMarker.length);

	if (src === next) { console.log(`[sync] ✅ ${label}: 已是最新，无改动`); return; }
	if (!dryRun) {
		backup(file);
		fs.writeFileSync(file, next, 'utf8');
		const chk = spawnSync(process.execPath, ['--check', file], { stdio: 'ignore' });
		if (chk.status !== 0) {
			fs.copyFileSync(`${file}.bak-modelsync-${stamp}`, file);
			console.error(`[sync] ❌ ${label}: 语法检查失败，已回滚`);
			return;
		}
	}
	console.log(`[sync] ✅ ${label}: FALLBACK_MODELS 已更新（${MODELS.length} 个模型）`);
}

/* ------------------------------------------------ 3. 更新 cc-switch catalog */

function updateCcSwitch() {
	if (!fs.existsSync(CC_SWITCH_DB)) { console.log('[sync] ⏭  cc-switch: 数据库不存在，跳过'); return; }
	const db = new DatabaseSync(CC_SWITCH_DB);
	const row = db.prepare(`SELECT settings_config FROM providers WHERE id = ? AND app_type = 'codex'`).get(CC_PROVIDER_ID);
	if (!row) { console.log(`[sync] ⏭  cc-switch: 没有 ${CC_PROVIDER_ID} 这个 provider，跳过`); return; }

	const cfg = JSON.parse(row.settings_config);
	const nextCatalog = {
		models: MODELS.map((m) => ({ model: m.id, displayName: m.displayName, contextWindow: m.ctx })),
	};

	// 若当前默认模型已下架，自动换成一个还在的
	const currentDefault = /^model\s*=\s*"(.+?)"/mu.exec(cfg.config)?.[1];
	let nextConfig = cfg.config;
	if (currentDefault && !MODELS.some((m) => m.id === currentDefault)) {
		const pick = MODELS.find((m) => m.id === 'deepseek-v4.1-flash') ?? MODELS[MODELS.length - 1];
		nextConfig = cfg.config.replace(/^model\s*=\s*".*?"\s*$/mu, `model = "${pick.id}"`);
		console.log(`[sync] ⚠️  cc-switch: 原默认模型 ${currentDefault} 已下架，改为 ${pick.id}`);
	}

	const before = JSON.stringify(cfg.modelCatalog);
	const after = JSON.stringify(nextCatalog);
	const changed = before !== after || nextConfig !== cfg.config;
	if (!changed) { console.log('[sync] ✅ cc-switch: modelCatalog 已是最新，无改动'); return; }

	cfg.modelCatalog = nextCatalog;
	cfg.config = nextConfig;
	if (!dryRun) {
		backup(CC_SWITCH_DB);
		db.prepare(`UPDATE providers SET settings_config = ? WHERE id = ? AND app_type = 'codex'`)
			.run(JSON.stringify(cfg), CC_PROVIDER_ID);
	}
	console.log(`[sync] ✅ cc-switch: modelCatalog 已更新（${MODELS.length} 个模型）`);
}

/* --------------------------------------------- 4. 更新 zcode config.json */

function zcodeModelEntry(m) {
	const input = m.img ? ['text', 'image'] : ['text'];
	const entry = {
		limit: { context: m.ctx, output: m.out },
		modalities: { input, output: ['text'] },
		zcode: { modalitiesConfigured: true, modified: true },
	};
	if (Array.isArray(m.efforts) && m.efforts.length > 0) {
		const variants = m.canOff ? ['off', ...m.efforts] : [...m.efforts];
		entry.reasoning = {
			enabled: true,
			variants,
			defaultVariant: m.efforts.includes('high') ? 'high' : m.efforts[0],
		};
	}
	return entry;
}

function updateZcodeConfig() {
	if (!fs.existsSync(ZCODE_CONFIG)) { console.log('[sync] ⏭  zcode config: 不存在，跳过'); return; }
	const cfg = JSON.parse(fs.readFileSync(ZCODE_CONFIG, 'utf8'));

	// zcode 的 provider 表挂在顶层 `provider` 下（不是 providers/agents）
	const table = cfg.provider;
	if (!table || typeof table !== 'object') {
		console.log('[sync] ⏭  zcode config: 找不到 provider 节点，跳过');
		return;
	}
	const p = table[ZCODE_PROVIDER_ID];
	if (!p) { console.log(`[sync] ⏭  zcode config: 没有 ${ZCODE_PROVIDER_ID}，跳过`); return; }

	const oldIds = Object.keys(p.models ?? {});
	const next = {};
	for (const m of MODELS) next[m.id] = zcodeModelEntry(m);

	// 幂等：内容没变就不写，避免每次一键更新都产生备份
	if (JSON.stringify(p.models ?? {}) === JSON.stringify(next)) {
		console.log(`[sync] ✅ zcode config: 已是最新，无改动（${Object.keys(next).length} 个）`);
		return;
	}

	p.models = next;

	if (!dryRun) {
		backup(ZCODE_CONFIG);
		fs.writeFileSync(ZCODE_CONFIG, JSON.stringify(cfg, null, 2), 'utf8');
	}

	const added = Object.keys(next).filter((id) => !oldIds.includes(id));
	const removed = oldIds.filter((id) => !(id in next));
	console.log(`[sync] ✅ zcode config: 模型表已更新（${Object.keys(next).length} 个）`
		+ (added.length ? `\n         新增: ${added.join(', ')}` : '')
		+ (removed.length ? `\n         移除: ${removed.join(', ')}` : ''));
}

/* ------------------------------------------- 5. 更新 DSH 插件兜底表 */

// 插件的兜底表条目格式（与上面三处不同）：
// { id, name, contextWindow, maxTokens, supportsImages,
//   reasoning: { supports, onlyReasoning, supportedEfforts?, defaultEffort, canDisableThinking },
//   billing: { credits?, badges?, free } }
function dshPluginEntry(m, raw) {
	const badges = [];
	for (const tag of raw?.tags ?? []) {
		const mt = /^badge:(.+?):#/u.exec(String(tag));
		if (mt) badges.push(mt[1]);
	}
	const credits = typeof raw?.credits === 'string' ? raw.credits : undefined;

	const reasoning = {
		supports: raw?.supportsReasoning !== false,
		onlyReasoning: raw?.onlyReasoning === true,
	};
	if (Array.isArray(m.efforts) && m.efforts.length) reasoning.supportedEfforts = m.efforts;
	reasoning.defaultEffort = typeof raw?.reasoning?.effort === 'string' ? raw.reasoning.effort
		: (Array.isArray(m.efforts) && m.efforts.includes('high') ? 'high' : (m.efforts?.[0] ?? 'medium'));
	reasoning.canDisableThinking = m.canOff === true;

	const billing = {};
	if (credits !== undefined) billing.credits = credits;
	if (badges.length) billing.badges = badges;
	billing.free = typeof credits === 'string' && /x0\.00/u.test(credits);

	return { id: m.id, name: m.displayName ?? m.id, contextWindow: m.ctx, maxTokens: m.out, supportsImages: m.img, reasoning, billing };
}

function updateDshPlugin() {
	// 插件可能装在多个 profile 下，全部更新
	const profilesDir = path.join(os.homedir(), '.dsh', 'profiles');
	if (!fs.existsSync(profilesDir)) { console.log('[sync] ⏭  DSH 插件: 找不到 ~/.dsh/profiles，跳过'); return; }

	const targets = [];
	for (const profile of fs.readdirSync(profilesDir)) {
		const lib = path.join(profilesDir, profile, 'node_modules', 'dsh-workbuddy-connect', 'lib');
		if (!fs.existsSync(lib)) continue;
		for (const f of fs.readdirSync(lib)) {
			if (f.startsWith('host-heartbeat') && f.endsWith('.js')) targets.push(path.join(lib, f));
		}
	}
	if (!targets.length) { console.log('[sync] ⏭  DSH 插件: 没找到 host-heartbeat*.js，跳过'); return; }

	for (const file of targets) {
		const src = fs.readFileSync(file, 'utf8');
		const at = src.indexOf('FALLBACK_WORKBUDDY_MODELS = [');
		if (at < 0) { console.log(`[sync] ⏭  DSH 插件 ${path.basename(path.dirname(path.dirname(file)))}: 找不到兜底表，跳过`); continue; }

		// 花括号/方括号配对定位数组结尾
		const open = src.indexOf('[', at);
		let depth = 0;
		let close = -1;
		let inStr = null;
		let esc = false;
		for (let i = open; i < src.length; i += 1) {
			const c = src[i];
			if (inStr !== null) {
				if (esc) esc = false;
				else if (c === '\\') esc = true;
				else if (c === inStr) inStr = null;
				continue;
			}
			if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
			if (c === '[') depth += 1;
			else if (c === ']') { depth -= 1; if (depth === 0) { close = i; break; } }
		}
		if (close < 0) { console.log('[sync] ⏭  DSH 插件: 数组结尾定位失败，跳过'); continue; }

		const body = MODELS.map((m) => '  ' + JSON.stringify(dshPluginEntry(m, RAW_BY_ID.get(m.id)), null, 2).split('\n').join('\n  ')).join(',\n');
		const next = src.slice(0, at) + `FALLBACK_WORKBUDDY_MODELS = [\n${body}\n]` + src.slice(close + 1);

		if (src === next) { console.log('[sync] ✅ DSH 插件: 已是最新，无改动'); continue; }
		if (!dryRun) {
			backup(file);
			fs.writeFileSync(file, next, 'utf8');
			const chk = spawnSync(process.execPath, ['--check', file], { stdio: 'ignore' });
			if (chk.status !== 0) {
				fs.copyFileSync(`${file}.bak-modelsync-${stamp}`, file);
				console.error('[sync] ❌ DSH 插件: 语法检查失败，已回滚');
				continue;
			}
		}
		console.log(`[sync] ✅ DSH 插件: 兜底表已更新（${MODELS.length} 个模型）  ${path.basename(file)}`);
	}
}

/* ----------------------------------------------------------- 6. 执行 */

if (want('codex')) updateFallbackTable(CODEX_PROXY, 'codex 代理 FALLBACK_MODELS');
if (want('zcode')) updateFallbackTable(ZCODE_PROXY, 'zcode 代理 FALLBACK_MODELS');
if (want('ccswitch')) updateCcSwitch();
if (want('zcode-config')) updateZcodeConfig();
if (want('dsh')) updateDshPlugin();

console.log('');
if (dryRun) {
	console.log('[sync] --dry-run：未写任何文件。去掉该参数以应用。');
} else if (backups.length) {
	console.log('[sync] 备份：');
	for (const b of backups) console.log(`   ${path.basename(b)}`);
} else {
	console.log('[sync] 无需改动。');
}
console.log('');
console.log('  提醒：改完要重启两个代理进程才生效。');
