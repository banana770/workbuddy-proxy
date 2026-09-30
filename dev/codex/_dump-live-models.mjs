// 拉取 WorkBuddy 上游的完整模型目录（含元数据），用于更新兜底表和 cc-switch catalog
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CN_CHAT_BASE = 'https://copilot.tencent.com';
const GLOBAL_BASE = 'https://www.workbuddy.ai';
const CN_REFERER = 'https://www.codebuddy.cn';
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';

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
	console.error('找不到凭据文件');
	process.exit(2);
}
console.log('凭据文件:', authPath);

const doc = JSON.parse(fs.readFileSync(authPath, 'utf8'));
const auth = typeof doc.auth === 'object' && doc.auth !== null ? doc.auth : doc;
const identity = typeof doc.account === 'object' && doc.account !== null ? doc.account : doc;
const accessToken = auth.accessToken ?? auth.credential?.accessToken;
if (!accessToken) {
	console.error('凭据里没有 accessToken');
	process.exit(2);
}
const domain = auth.domain ?? auth.credential?.domain ?? '';
const uid = identity.uid ?? '';
const enterpriseId = identity.enterpriseId ?? '';

const isGlobal = domain === 'workbuddy.ai' || domain.endsWith('.workbuddy.ai');
const base = isGlobal ? GLOBAL_BASE : CN_CHAT_BASE;
const referer = isGlobal ? GLOBAL_BASE : CN_REFERER;

const headers = {
	Authorization: `Bearer ${accessToken}`,
	Accept: 'application/json',
	Origin: referer,
	Referer: `${referer}/`,
	'User-Agent': CLIENT_UA,
};
if (uid) headers['X-User-Id'] = uid;
if (enterpriseId) headers['X-Enterprise-Id'] = enterpriseId;
if (domain) headers['X-Domain'] = domain;

const res = await fetch(`${base}/console/enterprises/personal/models`, { headers, signal: AbortSignal.timeout(30000) });
const text = await res.text();
console.log('HTTP', res.status, '| 响应长度', text.length);

let doc2;
try { doc2 = JSON.parse(text); } catch { console.error('非 JSON:', text.slice(0, 400)); process.exit(3); }
if (doc2.code !== 0) { console.error('上游返回 code=' + doc2.code + ' ' + (doc2.msg ?? '')); process.exit(3); }

const models = doc2.data?.models ?? [];
const agents = doc2.data?.agents ?? [];
console.log('models 总数:', models.length, '| agents:', agents.map((a) => a.name).join(', '));

const cliIds = agents.find((a) => a.name === 'cli')?.models ?? [];
console.log('cli agent 挂载模型数:', cliIds.length);
console.log('');

const byId = new Map(models.map((m) => [m.id, m]));
console.log('=== cli agent 可用模型（代理实际会暴露的） ===');
const rows = [];
for (const id of cliIds) {
	const m = byId.get(id);
	if (!m) { console.log(`  ${id}  (目录里没有)`); continue; }
	const disabled = m.disabled === true;
	rows.push({
		id: m.id,
		ctx: Number(m.maxInputTokens) || 200_000,
		out: Number(m.maxOutputTokens) || 32_000,
		img: m.supportsImages === true && m.disabledMultimodal !== true,
		efforts: Array.isArray(m.reasoning?.supportedEfforts) ? m.reasoning.supportedEfforts
			: typeof m.reasoning?.effort === 'string' ? [m.reasoning.effort] : undefined,
		canOff: m.reasoning?.canDisableThinking === true,
		disabled,
		displayName: m.displayName ?? m.name ?? m.id,
	});
}
for (const r of rows) {
	console.log(`  ${r.disabled ? '[禁用] ' : ''}${r.id.padEnd(22)} ctx=${String(r.ctx).padStart(9)} out=${String(r.out).padStart(7)} img=${r.img ? 'Y' : 'n'} efforts=${JSON.stringify(r.efforts)} canOff=${r.canOff}`);
}

console.log('\n=== 目录里存在但 cli agent 没挂的模型 ===');
for (const m of models) {
	if (!cliIds.includes(m.id)) console.log(`  ${m.id}${m.disabled ? ' [禁用]' : ''}`);
}

console.log('\n=== 可直接粘进 FALLBACK_MODELS 的代码 ===');
console.log('const FALLBACK_MODELS = [');
for (const r of rows.filter((x) => !x.disabled)) {
	console.log(`  { id: ${JSON.stringify(r.id)}, ctx: ${r.ctx.toLocaleString('en-US').replaceAll(',', '_')}, out: ${r.out.toLocaleString('en-US').replaceAll(',', '_')}, img: ${r.img}, efforts: ${JSON.stringify(r.efforts)}, canOff: ${r.canOff} },`);
}
console.log('];');

fs.writeFileSync(
	path.join(process.cwd(), '_live-models.json'),
	JSON.stringify(rows.filter((x) => !x.disabled), null, 2),
	'utf8'
);
console.log('\n已写出 _live-models.json');
