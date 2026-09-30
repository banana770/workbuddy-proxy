#!/usr/bin/env node
/**
 * Codex 真实链路验证：按 Codex 的 Responses API 线格式打 /v1/responses
 * ==================================================================
 * test-e2e.mjs 只覆盖了 /v1/chat/completions；但 Codex 用的是
 * wire_api = "responses"，实际请求打到 /v1/responses，请求体是
 * Responses 形状（instructions + input[]），响应是 SSE 事件流。
 * 本脚本专门验这一条。
 */
const BASE = 'http://127.0.0.1:8401';
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer workbuddy-local-proxy' };
const MODEL = process.argv[2] ?? 'glm-5.3-flash';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
	if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
	else { fail += 1; console.log(`  ❌ ${name}${detail ? '  → ' + detail : ''}`); }
};

function parseSSE(text) {
	const events = [];
	for (const line of text.split('\n')) {
		if (!line.startsWith('data:')) continue;
		const payload = line.slice(5).trim();
		if (!payload || payload === '[DONE]') continue;
		try { events.push(JSON.parse(payload)); } catch { /* ignore */ }
	}
	return events;
}

console.log('========================================');
console.log(' Codex /v1/responses 链路验证');
console.log('========================================');
console.log(` model: ${MODEL}`);
console.log('');

/* ---------- 用例 1：纯文本流式 ---------- */
console.log('[用例 1] Responses 流式纯文本');
{
	const res = await fetch(`${BASE}/v1/responses`, {
		method: 'POST',
		headers: H,
		body: JSON.stringify({
			model: MODEL,
			instructions: '你是一个简洁的编码助手，只回答一个词。',
			input: [{ role: 'user', content: [{ type: 'input_text', text: '天空是什么颜色？' }] }],
			stream: true,
			store: false,
			reasoning: { effort: 'low' },
			prompt_cache_key: 'codex-verify-1',
		}),
	});
	check('HTTP 200', res.status === 200, `status=${res.status}`);
	const text = await res.text();
	const events = parseSSE(text);
	const types = [...new Set(events.map((e) => e.type))];
	console.log('    事件类型: ' + types.join(', '));
	const deltas = events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta ?? '').join('');
	check('有 output_text.delta 内容', deltas.length > 0, `delta="${deltas.slice(0, 40)}"`);
	check('有 response.completed 收尾', types.includes('response.completed'));
	console.log(`    回答: ${JSON.stringify(deltas.slice(0, 80))}`);
}

/* ---------- 用例 2：工具调用 ---------- */
console.log('\n[用例 2] Responses 流式 + 工具调用（Codex 的真实形态）');
{
	const res = await fetch(`${BASE}/v1/responses`, {
		method: 'POST',
		headers: H,
		body: JSON.stringify({
			model: MODEL,
			instructions: '你必须调用 get_weather 工具来查询天气。',
			input: [{ role: 'user', content: [{ type: 'input_text', text: '上海今天天气如何？' }] }],
			tools: [{
				type: 'function',
				name: 'get_weather',
				description: '查询城市天气',
				parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
			}],
			tool_choice: 'auto',
			stream: true,
			store: false,
			reasoning: { effort: 'low' },
		}),
	});
	check('HTTP 200', res.status === 200, `status=${res.status}`);
	const text = await res.text();
	const events = parseSSE(text);
	const types = [...new Set(events.map((e) => e.type))];
	console.log('    事件类型: ' + types.join(', '));

	const callEvents = events.filter((e) => e.type === 'response.output_item.added' || e.type === 'response.output_item.done');
	const fc = callEvents.map((e) => e.item).find((it) => it?.type === 'function_call');
	check('产出了 function_call 项', Boolean(fc), fc ? '' : '未看到 function_call');
	if (fc) {
		check('function_call 有名字', typeof fc.name === 'string' && fc.name.length > 0, `name=${fc.name}`);
		console.log(`    工具: ${fc.name}  参数: ${String(fc.arguments).slice(0, 80)}`);
	}

	const argsDeltas = events.filter((e) => e.type === 'response.function_call_arguments.delta').map((e) => e.delta ?? '').join('');
	check('有 arguments 增量事件', argsDeltas.length > 0 || Boolean(fc), `delta="${argsDeltas.slice(0, 60)}"`);
}

/* ---------- 用例 3：多轮 + function_call_output 回环 ---------- */
console.log('\n[用例 3] function_call_output 回环（Codex 第二轮必走）');
{
	const res = await fetch(`${BASE}/v1/responses`, {
		method: 'POST',
		headers: H,
		body: JSON.stringify({
			model: MODEL,
			instructions: '你是一个简洁的编码助手。',
			input: [
				{ role: 'user', content: [{ type: 'input_text', text: '上海今天天气如何？' }] },
				{ type: 'function_call', call_id: 'call_test_1', name: 'get_weather', arguments: '{"city":"上海"}' },
				{ type: 'function_call_output', call_id: 'call_test_1', output: '晴，26度，东南风2级' },
			],
			tools: [{
				type: 'function',
				name: 'get_weather',
				description: '查询城市天气',
				parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
			}],
			stream: true,
			store: false,
			reasoning: { effort: 'low' },
		}),
	});
	check('HTTP 200', res.status === 200, `status=${res.status}`);
	const text = await res.text();
	const events = parseSSE(text);
	const deltas = events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta ?? '').join('');
	check('回环后产出了文本回答', deltas.length > 0);
	console.log(`    回答: ${JSON.stringify(deltas.slice(0, 160))}`);
}

console.log('\n----------------------------------------');
console.log(` 结果：${pass} 通过 / ${fail} 失败`);
console.log('----------------------------------------');
process.exit(fail > 0 ? 1 : 0);
