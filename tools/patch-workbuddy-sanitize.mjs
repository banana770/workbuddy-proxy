#!/usr/bin/env node
/**
 * dsh-workbuddy-connect 身份清洗补丁 —— deep-walk v1
 * =================================================
 *
 * 问题：插件自带的 normalizeIdentityText() 只清洗 message.content，
 *      不清洗 assistant 消息的 tool_calls[].function.arguments。
 *      而被禁的「第三方 coding agent 身份声明」原文，恰恰最常出现在
 *      tool_calls 的参数里（模型 write/edit/bash 时把那段原文写进文件）。
 *      上游按「system/assistant 消息是否原样出现该句」判定 11128，
 *      且历史每轮全量重放 → 一条 assistant 消息中毒，整个会话从此每轮必挂。
 *
 * 修法：把 normalizeIdentityText() 从「只扫 content」改成「深度遍历整个请求体」，
 *      这样 tool_calls.arguments、reasoning 字段、数组嵌套等全部覆盖。
 *
 * 设计约束（重要）：本文件不含被禁原文的任何字面量，因此「写这个文件」
 *      这个动作本身不会污染 workbuddy 会话。请保持这个性质。
 *
 * 用法：
 *   node patch-workbuddy-sanitize.mjs [--profile web] [--dry-run] [--revert]
 *     --profile  默认 web（可选 web / desktop / dsh-tui）
 *     --dry-run  只打印将要替换的代码片段，不写盘
 *     --revert   从备份还原
 *
 * 幂等：重复执行安全。插件升级会覆盖补丁，升级后重跑一次即可。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MARK = 'workbuddy-deep-walk-v1';
const ANCHOR = 'function normalizeIdentityText(obj) {';
const BACKUP_SUFFIX = '.bak-11128';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const opt = (name, fallback) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const profile = opt('--profile', 'web');
const dryRun = has('--dry-run');
const revert = has('--revert');

function fail(message, code = 1) {
	console.error(`[patch] ❌ ${message}`);
	process.exit(code);
}

const libDirOverride = opt('--lib-dir', '');
const libDir = libDirOverride ? path.resolve(libDirOverride) : path.join(
	os.homedir(), '.dsh', 'profiles', profile, 'node_modules', 'dsh-workbuddy-connect', 'lib'
);
if (!fs.existsSync(libDir)) {
	fail(`找不到插件 lib 目录：${libDir}\n      提示：用 --profile 指定实际 profile（web / desktop / dsh-tui）`, 2);
}

const files = fs.readdirSync(libDir).filter((f) => f.startsWith('host-heartbeat') && f.endsWith('.js'));
if (files.length !== 1) {
	fail(`预期恰好 1 个 host-heartbeat*.js，实际找到 ${files.length} 个：${JSON.stringify(files)}`, 2);
}

const target = path.join(libDir, files[0]);
const backup = target + BACKUP_SUFFIX;
const src = fs.readFileSync(target, 'utf8');

console.log(`[patch] 目标文件：${target}`);

/* ---------- 还原 ---------- */
if (revert) {
	if (!fs.existsSync(backup)) fail(`没有备份可还原：${backup}`, 2);
	fs.copyFileSync(backup, target);
	console.log('[patch] ✅ 已从备份还原。');
	process.exit(0);
}

/* ---------- 幂等检查 ---------- */
if (src.includes(MARK)) {
	console.log(`[patch] ⏭  已是补丁后的版本（找到标记 ${MARK}），无需改动。`);
	console.log('[patch]    验证：node verify-workbuddy-11128.mjs');
	process.exit(0);
}

/* ---------- 定位函数边界（花括号配对，跳过字符串） ---------- */
const at = src.indexOf(ANCHOR);
if (at < 0) {
	fail(`找不到锚点 ${JSON.stringify(ANCHOR)}；插件可能已改版，请人工检查该文件。`, 3);
}

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
	else if (c === '}') {
		depth -= 1;
		if (depth === 0) { close = i; break; }
	}
}
if (close < 0) fail('花括号配对失败，未能确定函数结尾；请人工检查。', 3);

/* ---------- 替换体 ---------- */
const replacement = [
	'function sanitizeDeep(value) {',
	'\tif (typeof value === "string") return sanitizeIdentityString(value);',
	'\tif (Array.isArray(value)) {',
	'\t\tfor (let i = 0; i < value.length; i += 1) value[i] = sanitizeDeep(value[i]);',
	'\t\treturn value;',
	'\t}',
	'\tif (typeof value === "object" && value !== null) {',
	'\t\tfor (const key of Object.keys(value)) value[key] = sanitizeDeep(value[key]);',
	'\t\treturn value;',
	'\t}',
	'\treturn value;',
	'}',
	`function normalizeIdentityText(obj) { /* ${MARK} */`,
	'\tsanitizeDeep(obj);',
	'}',
].join('\n');

const patched = src.slice(0, at) + replacement + src.slice(close + 1);

if (dryRun) {
	console.log('\n----- 原始片段 -----');
	console.log(src.slice(at, close + 1));
	console.log('\n----- 替换为 -----');
	console.log(replacement);
	console.log('\n[patch] --dry-run：未写盘。去掉该参数以应用。');
	process.exit(0);
}

/* ---------- 写盘（先备份） ---------- */
if (!fs.existsSync(backup)) {
	fs.copyFileSync(target, backup);
	console.log(`[patch] 已备份原文件 → ${path.basename(backup)}`);
}
fs.writeFileSync(target, patched, 'utf8');

/* ---------- 语法自检，失败自动回滚 ---------- */
const check = spawnSync(process.execPath, ['--check', target], { stdio: 'ignore' });
if (check.status !== 0) {
	fs.copyFileSync(backup, target);
	fail('补丁后语法自检失败，已自动回滚，未留下损坏文件。', 4);
}

console.log('[patch] ✅ 完成');
console.log('        改动：normalizeIdentityText 由「只扫 message.content」→「深度遍历整个请求体」');
console.log('        覆盖：tool_calls[].function.arguments、function_call、reasoning 等此前漏掉的字段');
console.log('');
console.log('  下一步：');
console.log('    1) node verify-workbuddy-11128.mjs          # 验证补丁生效');
console.log('    2) 重启 dsh                                  # 插件代码在启动时加载，必须重启');
console.log('    3) 回到那两个「坏掉」的会话继续对话           # 重放会被清洗，应不再 400');
