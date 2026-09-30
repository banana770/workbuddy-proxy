#!/usr/bin/env node
/**
 * codex-workbuddy-proxy 身份清洗补丁 —— deep-walk v1
 * ==================================================
 *
 * 与 dsh-workbuddy-connect 完全同源的问题：
 *   proxy.mjs 的 enforceUpstreamPolicy() 只清洗 message.content，
 *   不清洗 assistant 的 tool_calls[].function.arguments。
 *
 * 对 Codex 尤其致命：Codex 的 function_call（apply_patch / shell 等）
 * 参数里天然带文件内容。一旦某次工具调用的参数里出现了被禁的
 * 「第三方 coding agent 身份声明」原文，那条 assistant 消息就会永久
 * 留在历史里，被上游每次判定 11128。
 *
 * 修法：把 enforceUpstreamPolicy() 改成深度遍历整个 messages。
 *
 * 用法：
 *   node patch-codex-proxy.mjs [--file <proxy.mjs 路径>] [--dry-run] [--revert]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MARK = 'codex-proxy-deep-walk-v1';
const ANCHOR = 'function enforceUpstreamPolicy(body) {';
const BACKUP_SUFFIX = '.bak-11128';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const defaultTarget = path.join(import.meta.dirname, '..', 'codex-workbuddy-proxy', 'proxy.mjs');
const target = path.resolve(opt('--file', defaultTarget));
const backup = target + BACKUP_SUFFIX;
const dryRun = has('--dry-run');
const revert = has('--revert');

function fail(message, code = 1) {
	console.error(`[proxy-patch] ❌ ${message}`);
	process.exit(code);
}

if (!fs.existsSync(target)) {
	fail(`找不到 ${target}\n      用 --file 指定 proxy.mjs 的实际路径。`, 2);
}

const src = fs.readFileSync(target, 'utf8');
console.log(`[proxy-patch] 目标文件：${target}`);

if (revert) {
	if (!fs.existsSync(backup)) fail(`没有备份可还原：${backup}`, 2);
	fs.copyFileSync(backup, target);
	console.log('[proxy-patch] ✅ 已从备份还原。');
	process.exit(0);
}

if (src.includes(MARK)) {
	console.log(`[proxy-patch] ⏭  已是补丁后的版本（${MARK}），无需改动。`);
	process.exit(0);
}

if (!src.includes('function sanitizeIdentityText(')) {
	fail('目标文件里找不到 sanitizeIdentityText()，可能不是预期的 proxy.mjs。', 3);
}

const at = src.indexOf(ANCHOR);
if (at < 0) fail(`找不到锚点 ${JSON.stringify(ANCHOR)}；proxy.mjs 可能已改版。`, 3);

const open = src.indexOf('{', at);
let depth = 0;
let close = -1;
let inStr = null;
let escaped = false;
for (let i = open; i < src.length; i += 1) {
	const c = src[i];
	if (inStr !== null) {
		if (escaped) escaped = false;
		else if (c === '\\') escaped = true;
		else if (c === inStr) inStr = null;
		continue;
	}
	if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
	if (c === '{') depth += 1;
	else if (c === '}') { depth -= 1; if (depth === 0) { close = i; break; } }
}
if (close < 0) fail('花括号配对失败，未能确定函数结尾。', 3);

const replacement = [
	'/** 深度遍历任意 JSON 值，清洗所有字符串（含 tool_calls 的 arguments）。 */',
	'function sanitizeDeep(value) {',
	'  if (typeof value === "string") return sanitizeIdentityText(value);',
	'  if (Array.isArray(value)) {',
	'    for (let i = 0; i < value.length; i += 1) value[i] = sanitizeDeep(value[i]);',
	'    return value;',
	'  }',
	'  if (typeof value === "object" && value !== null) {',
	'    for (const key of Object.keys(value)) value[key] = sanitizeDeep(value[key]);',
	'    return value;',
	'  }',
	'  return value;',
	'}',
	'',
	'/**',
	` * Apply the role rewrite and identity sanitization to every message part. (${MARK})`,
	' * 深度遍历整个 messages，而不是只扫 content —— tool_calls[].function.arguments',
	' * 是 Codex 工具参数落地的位置，也是此前漏扫导致 11128 的根因。',
	' */',
	'function enforceUpstreamPolicy(body) {',
	'  if (!Array.isArray(body?.messages)) return body;',
	'  for (const m of body.messages) {',
	'    if (!m || typeof m !== "object") continue;',
	'    if (m.role === "developer") m.role = "system";',
	'  }',
	'  sanitizeDeep(body.messages);',
	'  return body;',
	'}',
].join('\n');

const patched = src.slice(0, at) + replacement + src.slice(close + 1);

if (dryRun) {
	console.log('\n----- 原始片段 -----');
	console.log(src.slice(at, close + 1));
	console.log('\n----- 替换为 -----');
	console.log(replacement);
	console.log('\n[proxy-patch] --dry-run：未写盘。');
	process.exit(0);
}

if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);
fs.writeFileSync(target, patched, 'utf8');

const check = spawnSync(process.execPath, ['--check', target], { stdio: 'ignore' });
if (check.status !== 0) {
	fs.copyFileSync(backup, target);
	fail('补丁后语法自检失败，已自动回滚。', 4);
}

console.log('[proxy-patch] ✅ 完成');
console.log('        改动：enforceUpstreamPolicy 现在深度遍历 messages');
console.log('        覆盖：tool_calls[].function.arguments（Codex 工具参数，此前漏扫）');
console.log('');
console.log('  下一步：');
console.log('    1) node proxy.mjs                # 重启代理（后台）');
console.log('    2) node test-e2e.mjs             # 端到端自测');
console.log('    3) 用 Codex 实跑一轮，确认不再 11128');
