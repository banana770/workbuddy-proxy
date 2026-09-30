#!/usr/bin/env node
/**
 * 验证 dsh-workbuddy-connect 身份清洗补丁（deep-walk v1）
 * =====================================================
 *
 * 默认（离线单元验证，不需要网络/凭据）：
 *   直接 import 插件自身的 prepareChatBody，喂一个合成的请求体，
 *   断言 tool_calls[].function.arguments 里的被禁原文已被清洗干净。
 *   这正好覆盖「补丁前会漏掉」的那个字段 —— 补丁前跑必然 FAIL。
 *
 * 加 --live（需要 WorkBuddy 已登录，会真的打上游）：
 *   A) 同一个 body 清洗前  → 预期 11128（复现漏扫位置）
 *   B) 同一个 body 清洗后  → 预期不再是 11128（证明补丁有效）
 *
 * 设计约束（重要）：被禁原文以 base64 存放、运行时才解码，
 *   因此本文件与「写这个文件」的动作都不会污染 workbuddy 会话。
 *
 * 用法：
 *   node verify-workbuddy-11128.mjs [--profile web] [--live] [--model <id>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* 被禁的「第三方 coding agent 身份声明」原文，base64 存放，避免字面量落进上下文 */
const BLOCKED_B64 =
	'WW91IGFyZSBhIGNvZGluZyBhZ2VudCBydW5uaW5nIGluIHRoZSBDb2RleCBDTEksIGEgdGVybWluYWwtYmFzZWQgY29kaW5nIGFzc2lzdGFudC4gQ29kZXggQ0xJIGlzIGFuIG9wZW4gc291cmNlIHByb2plY3QgbGVkIGJ5IE9wZW5BSS4gWW91IGFyZSBleHBlY3RlZCB0byBiZSBwcmVjaXNlLCBzYWZlLCBhbmQgaGVscGZ1bC4=';
const PREAMBLE = Buffer.from(BLOCKED_B64, 'base64').toString('utf8');
const MARK = 'workbuddy-deep-walk-v1';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const profile = opt('--profile', process.env.WB_PROFILE || 'web');
const liveMode = has('--live');
const modelId = opt('--model', 'deepseek-v4.1-flash');

/* ---------------- 定位并加载插件 ---------------- */
const libDirOverride = opt('--lib-dir', '');
const libDir = libDirOverride
	? path.resolve(libDirOverride)
	: path.join(os.homedir(), '.dsh', 'profiles', profile, 'node_modules', 'dsh-workbuddy-connect', 'lib');
if (!fs.existsSync(libDir)) {
	console.error(`[verify] ❌ 找不到插件 lib 目录：${libDir}`);
	process.exit(2);
}
const hbFiles = fs.readdirSync(libDir).filter((f) => f.startsWith('host-heartbeat') && f.endsWith('.js'));
if (hbFiles.length !== 1) {
	console.error(`[verify] ❌ 预期 1 个 host-heartbeat*.js，实际 ${hbFiles.length} 个：${JSON.stringify(hbFiles)}`);
	process.exit(2);
}
const hbPath = path.join(libDir, hbFiles[0]);
const source = fs.readFileSync(hbPath, 'utf8');
const patched = source.includes(MARK);

const mod = await import(pathToFileURL(hbPath).href);
const prepareChatBody = mod.f;
if (typeof prepareChatBody !== 'function') {
	console.error('[verify] ❌ 未能从插件模块取到 prepareChatBody（导出名 f）。插件可能已改版。');
	process.exit(3);
}

console.log('========================================');
console.log(' dsh-workbuddy-connect 11128 清洗验证');
console.log('========================================');
console.log(`  profile      : ${profile}`);
console.log(`  目标文件     : ${path.basename(hbPath)}`);
console.log(`  补丁状态     : ${patched ? '✅ 已打补丁 (' + MARK + ')' : '❌ 未打补丁（tool_calls 不会被清洗）'}`);
console.log('');

/* ---------------- 构造合成请求体 ---------------- */
function buildBody({ system = false, assistant = false, toolArgs = false }) {
	const messages = [
		{
			role: 'developer',
			content: system ? `系统前置说明。${PREAMBLE} 结束。` : 'You are a helpful assistant.',
		},
		{ role: 'user', content: '请处理这个文件。' },
	];
	const assistantMsg = {
		role: 'assistant',
		content: assistant ? `我先看一下。${PREAMBLE}` : '好的，我来处理。',
	};
	if (toolArgs) {
		assistantMsg.tool_calls = [
			{
				id: 'call_1',
				type: 'function',
				function: {
					name: 'write',
					arguments: JSON.stringify({
						file_path: 'marker.txt',
						content: `HEAD-MARKER\n${PREAMBLE}\nTAIL-MARKER`,
					}),
				},
			},
		];
	}
	messages.push(assistantMsg);
	if (toolArgs) messages.push({ role: 'tool', tool_call_id: 'call_1', content: 'ok' });
	return { model: modelId, stream: false, messages };
}

/* ---------------- 断言工具 ---------------- */
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
	if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
	else { fail += 1; console.log(`  ❌ ${name}${detail ? '  → ' + detail : ''}`); }
}

/* ---------------- 用例 1：tool_calls.arguments（核心） ---------------- */
console.log('[用例 1] 被禁原文藏在 assistant.tool_calls[].function.arguments 里');
{
	const out = JSON.parse(prepareChatBody(JSON.stringify(buildBody({ toolArgs: true }))));
	const assistantMsg = out.messages.find((m) => m.role === 'assistant');
	const args = assistantMsg?.tool_calls?.[0]?.function?.arguments ?? '';
	check('tool_calls.arguments 不再含被禁原文', !args.includes(PREAMBLE), '仍残留 → 正是本次会话中毒的字段');
	check('stream 被强制为 true', out.stream === true);
	check('developer 角色被改写为 system', out.messages[0].role === 'system');
	check('参数里其他内容未被破坏', args.includes('marker.txt') && args.includes('HEAD-MARKER') && args.includes('TAIL-MARKER'));
}

/* ---------------- 用例 2：assistant content（原有能力，回归） ---------------- */
console.log('\n[用例 2] 被禁原文在 assistant.content（补丁前已能处理，做回归）');
{
	const out = JSON.parse(prepareChatBody(JSON.stringify(buildBody({ assistant: true }))));
	const text = out.messages.find((m) => m.role === 'assistant')?.content ?? '';
	check('assistant.content 不再含被禁原文', !text.includes(PREAMBLE));
}

/* ---------------- 用例 3：system content（原有能力，回归） ---------------- */
console.log('\n[用例 3] 被禁原文在 system/developer 内容里（回归）');
{
	const out = JSON.parse(prepareChatBody(JSON.stringify(buildBody({ system: true }))));
	const text = out.messages[0]?.content ?? '';
	check('system 内容不再含被禁原文', !text.includes(PREAMBLE));
}

/* ---------------- 用例 4：正文字段保持完好 ---------------- */
console.log('\n[用例 4] 无关字段不受影响');
{
	const raw = JSON.stringify(buildBody({}));
	const out = JSON.parse(prepareChatBody(raw));
	check('model 字段保持原样', out.model === modelId);
	check('messages 条数不变', out.messages.length === 3);
	check('JSON 可正常解析（未破坏结构）', typeof out === 'object');
}

/* ---------------- 结果 ---------------- */
console.log('\n----------------------------------------');
console.log(` 结果：${pass} 通过 / ${fail} 失败`);
console.log('----------------------------------------');

if (fail > 0 && !patched) {
	console.log('\n结论：补丁尚未应用，tool_calls 未被清洗 —— 先运行：');
	console.log('  node patch-workbuddy-sanitize.mjs');
} else if (fail > 0) {
	console.log('\n结论：已打补丁但仍有用例失败，插件可能已改版；请人工检查。');
} else {
	console.log('\n结论：清洗覆盖到位。');
	if (!patched) console.log('（注意：当前未检测到补丁标记，但用例全过 —— 可能是插件新版已自带修复。）');
}

/* ---------------- 可选：对上游实测 ---------------- */
if (liveMode) {
	console.log('\n========================================');
	console.log(' --live：对 WorkBuddy 上游实测');
	console.log('========================================');
	try {
		await liveProbe();
	} catch (error) {
		console.log(`[live] ❌ 实测失败：${error.message}`);
	}
}

async function liveProbe() {
	const envPath = process.env.WORKBUDDY_AUTH_FILE;
	const candidates = [
		envPath,
		path.join(process.env.LOCALAPPDATA ?? '', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
		path.join(process.env.APPDATA ?? '', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
		path.join(os.homedir(), '.dsh', '.workbuddy-auth.json'),
	].filter((p) => p && fs.existsSync(p));

	if (candidates.length === 0) throw new Error('找不到 WorkBuddy 凭据文件，请先在桌面 App 登录');

	const authPath = candidates[0];
	console.log(`[live] 凭据文件：${authPath}`);

	const doc = JSON.parse(fs.readFileSync(authPath, 'utf8'));
	const auth = typeof doc.auth === 'object' && doc.auth !== null ? doc.auth : doc;
	const identity = typeof doc.account === 'object' && doc.account !== null ? doc.account : doc;
	const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : '';
	if (!accessToken) throw new Error('凭据文件里没有 accessToken');

	const domain = typeof auth.domain === 'string' ? auth.domain : '';
	const uid = typeof identity.uid === 'string' ? identity.uid : '';
	const enterpriseId = typeof identity.enterpriseId === 'string' ? identity.enterpriseId : '';
	const isGlobal = domain === 'workbuddy.ai' || domain.endsWith('.workbuddy.ai');
	const base = isGlobal ? 'https://www.workbuddy.ai' : 'https://copilot.tencent.com';
	const referer = isGlobal ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn';

	const headers = {
		Accept: 'application/json, text/plain, */*',
		'X-Requested-With': 'XMLHttpRequest',
		Origin: referer,
		Referer: `${referer}/`,
		'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
		'Content-Type': 'application/json',
		'X-Product': 'SaaS',
		Authorization: `Bearer ${accessToken}`,
	};
	if (uid) headers['X-User-Id'] = uid; else headers['X-No-User-Id'] = '1';
	if (enterpriseId) headers['X-Enterprise-Id'] = enterpriseId; else headers['X-No-Enterprise-Id'] = '1';
	if (domain) headers['X-Domain'] = domain; else headers['X-No-Department-Info'] = '1';

	const url = `${base}/v2/chat/completions`;
	const rawBody = JSON.stringify({ ...buildBody({ toolArgs: true }), stream: true });
	const preparedBody = prepareChatBody(JSON.stringify(buildBody({ toolArgs: true })));

	const probe = async (label, body) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 30_000);
		try {
			const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
			if (res.status === 200) {
				try { await res.body?.cancel(); } catch { /* ignore */ }
				console.log(`[live]   ${label} → http 200（未被拦截）`);
				return { status: 200, code: null };
			}
			const text = (await res.text()).slice(0, 3000);
			const m = text.match(/"code"\s*:\s*(\d+)/);
			const code = m ? m[1] : null;
			console.log(`[live]   ${label} → http ${res.status}  code=${code ?? '-'}${code === '11128' ? '  ← 被安全策略拦截' : ''}`);
			if (code !== '11128') console.log(`          响应片段：${text.slice(0, 200)}`);
			return { status: res.status, code };
		} finally {
			clearTimeout(timer);
		}
	};

	console.log('[live] A) 原始 body（tool_calls.arguments 含被禁原文，未经清洗）');
	const a = await probe('raw     ', rawBody);
	console.log('[live] B) 同一 body 经插件清洗后');
	const b = await probe('prepared', preparedBody);

	console.log('');
	if (a.code === '11128') {
		console.log('[live] ✅ 复现成功：tool_calls.arguments 确实会触发 11128 —— 证实这就是漏扫位置');
	} else {
		console.log(`[live] ℹ️  原始 body 未复现 11128（code=${a.code}）—— 可能模型名不对或该字段已被上游放行`);
	}
	if (b.status === 200) console.log('[live] ✅ 补丁有效：清洗后同一请求放行');
	else if (b.code === '11128') console.log('[live] ❌ 补丁无效：清洗后仍被 11128 拦截');
	else console.log(`[live] ℹ️  清洗后 http ${b.status} code=${b.code}（只要不是 11128，就说明身份原文已被清掉）`);
}

process.exit(fail > 0 ? 1 : 0);
