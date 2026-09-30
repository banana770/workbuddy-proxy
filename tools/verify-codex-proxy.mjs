#!/usr/bin/env node
/**
 * 验证 codex-workbuddy-proxy 的身份清洗是否覆盖 tool_calls.arguments
 * =================================================================
 *
 * 原理：从 proxy.mjs 源码里切出 IDENTITY_* / sanitizeIdentityText /
 * enforceUpstreamPolicy 这一段，用 new Function 在内存里求值，
 * 然后拿真实的 enforceUpstreamPolicy 跑断言。
 *
 * 被禁原文始终留在磁盘源码里，不进本文件、不进对话上下文。
 *
 * 用法：
 *   node verify-codex-proxy.mjs [--file <proxy.mjs 路径>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARK = 'codex-proxy-deep-walk-v1';
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const defaultTarget = path.join(import.meta.dirname, '..', 'codex-workbuddy-proxy', 'proxy.mjs');
const target = path.resolve(opt('--file', defaultTarget));

if (!fs.existsSync(target)) {
	console.error(`[verify-proxy] ❌ 找不到 ${target}（用 --file 指定）`);
	process.exit(2);
}

const src = fs.readFileSync(target, 'utf8');
const START = 'const IDENTITY_PREAMBLES';
const END = 'async function callUpstream';
const start = src.indexOf(START);
const end = src.indexOf(END);
if (start < 0 || end < 0) {
	console.error('[verify-proxy] ❌ 未能在源码里定位清洗相关代码段，proxy.mjs 可能已改版。');
	process.exit(3);
}

const slice = src.slice(start, end);
let factory;
try {
	factory = new Function(`${slice}\nreturn { enforceUpstreamPolicy, IDENTITY_PREAMBLES };`);
} catch (error) {
	console.error(`[verify-proxy] ❌ 代码段求值失败：${error.message}`);
	process.exit(3);
}
const { enforceUpstreamPolicy, IDENTITY_PREAMBLES } = factory();
const PREAMBLE = IDENTITY_PREAMBLES[0];

console.log('========================================');
console.log(' codex-workbuddy-proxy 清洗验证');
console.log('========================================');
console.log(`  目标文件 : ${target}`);
console.log(`  补丁状态 : ${src.includes(MARK) ? '✅ 已打补丁 (' + MARK + ')' : '❌ 未打补丁（tool_calls 不会被清洗）'}`);
console.log('');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
	if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
	else { fail += 1; console.log(`  ❌ ${name}${detail ? '  → ' + detail : ''}`); }
};

/* 用例 1：Codex 工具参数（核心漏扫位置） */
console.log('[用例 1] 被禁原文藏在 assistant.tool_calls[].function.arguments（Codex 工具参数）');
{
	const body = {
		model: 'glm-5.3-flash',
		messages: [
			{ role: 'user', content: '改一下这个文件' },
			{
				role: 'assistant',
				content: '好的',
				tool_calls: [{
					id: 'call_1',
					type: 'function',
					function: {
						name: 'apply_patch',
						arguments: JSON.stringify({ patch: `HEAD-MARKER\n${PREAMBLE}\nTAIL-MARKER` }),
					},
				}],
			},
			{ role: 'tool', tool_call_id: 'call_1', content: 'done' },
		],
	};
	enforceUpstreamPolicy(body);
	const args = body.messages[1].tool_calls[0].function.arguments;
	check('tool_calls.arguments 不再含被禁原文', !args.includes(PREAMBLE), '仍残留 → 这就是 Codex 侧会话中毒的字段');
	check('参数里其他内容未被破坏', args.includes('HEAD-MARKER') && args.includes('TAIL-MARKER'));
}

/* 用例 2：assistant content（回归） */
console.log('\n[用例 2] 被禁原文在 assistant.content（补丁前已能处理，做回归）');
{
	const body = { messages: [{ role: 'assistant', content: `前言 ${PREAMBLE} 后语` }] };
	enforceUpstreamPolicy(body);
	check('assistant.content 不再含被禁原文', !body.messages[0].content.includes(PREAMBLE));
}

/* 用例 3：developer → system 改写（回归） */
console.log('\n[用例 3] developer 角色改写（回归）');
{
	const body = { messages: [{ role: 'developer', content: '你是助手' }] };
	enforceUpstreamPolicy(body);
	check('developer 被改写为 system', body.messages[0].role === 'system');
}

/* 用例 4：结构未被破坏 */
console.log('\n[用例 4] 结构完整性');
{
	const body = {
		model: 'm',
		messages: [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'ok', tool_calls: [{ id: 'c', type: 'function', function: { name: 'n', arguments: '{"a":1}' } }] },
		],
	};
	enforceUpstreamPolicy(body);
	check('messages 条数不变', body.messages.length === 2);
	check('tool_calls 结构保持', Array.isArray(body.messages[1].tool_calls) && body.messages[1].tool_calls[0].function.name === 'n');
	check('合法 JSON 参数未被破坏', JSON.parse(body.messages[1].tool_calls[0].function.arguments).a === 1);
}

console.log('\n----------------------------------------');
console.log(` 结果：${pass} 通过 / ${fail} 失败`);
console.log('----------------------------------------');
if (fail > 0 && !src.includes(MARK)) {
	console.log('\n结论：补丁未应用。运行：');
	console.log(`  node patch-codex-proxy.mjs --file "${target}"`);
} else if (fail > 0) {
	console.log('\n结论：已打补丁但仍有失败用例，请人工检查。');
} else {
	console.log('\n结论：清洗覆盖到位。');
}

process.exit(fail > 0 ? 1 : 0);
