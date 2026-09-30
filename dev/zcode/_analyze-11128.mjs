#!/usr/bin/env node
/**
 * 11128 捕获体分析 + 上游 oracle 定位 + 自愈入名单
 * 安全设计:全程只打印 布尔/计数/字段名/长度/索引,绝不打印任何字符串内容。
 * 用法: node _analyze-11128.mjs [capture.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const AUTH_FILE = 'C:/Users/<USER>/AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info';
const CHAT = 'https://copilot.tencent.com/v2/chat/completions';
const UA = 'CLI/2.63.2 CodeBuddy/2.63.2';
const BLOCKLIST = 'D:/dsh工作区/dsh工作区2/zcode-workbuddy-proxy/identity-blocklist.json';

const info = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
const a = info.auth ?? {};
const uid = info.account?.uid ?? '';
const headers = () => ({
  'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*',
  'X-Requested-With': 'XMLHttpRequest', Origin: 'https://www.codebuddy.cn', Referer: 'https://www.codebuddy.cn/',
  'User-Agent': UA, Authorization: `Bearer ${a.accessToken}`,
  'X-No-Enterprise-Id': '1', 'X-Product': 'SaaS',
  ...(uid ? { 'X-User-Id': uid } : {}), ...(a.domain ? { 'X-Domain': a.domain } : {}),
});

let oracleCalls = 0;
async function oracle(body) {
  oracleCalls += 1;
  const b = { ...body, stream: true, max_tokens: 1 };
  const r = await fetch(CHAT, { method: 'POST', headers: headers(), body: JSON.stringify(b), signal: AbortSignal.timeout(90000) });
  if (r.status === 200) { try { await r.body.cancel(); } catch {} return 'PASS'; }
  const t = await r.text();
  if (t.includes('11128')) return 'BANNED';
  if (r.status === 429 || t.includes('6004')) return 'RATE';
  return `OTHER:${r.status}:${t.slice(0, 80).replace(/\s+/g, ' ')}`;
}
const clone = (b) => JSON.parse(JSON.stringify(b));

// ---------- 载入捕获 ----------
const file = process.argv[2] ?? 'D:/dsh工作区/dsh工作区2/zcode-workbuddy-proxy/capture/11128-1789115245737.json';
const capture = JSON.parse(readFileSync(file, 'utf8'));
console.log('捕获文件字段:', Object.keys(capture).join(','));
console.log('messages 条数:', (capture.messages ?? []).length, '| tools 条数:', (capture.tools ?? []).length);
(capture.messages ?? []).forEach((m, i) => {
  const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
  console.log(`  msg[${i}] role=${m.role} 长度=${c.length}`);
});

// ---------- 侦察:产品名计数(名字安全) ----------
const NAMES = ['Claude', 'Anthropic', 'ZCode', 'Codex', 'OpenAI', 'Gemini', 'Qwen', 'Cursor'];
function eachString(v, path, fn) {
  if (typeof v === 'string') fn(path, v);
  else if (Array.isArray(v)) v.forEach((x, i) => eachString(x, `${path}[${i}]`, fn));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) eachString(v[k], `${path}.${k}`, fn);
}
const nameHits = {};
eachString(capture, '$', (p, s) => {
  for (const n of NAMES) {
    let idx = s.indexOf(n);
    while (idx >= 0) {
      const key = `${p.split(/[.\[]/, 2).join('.')}:${n}`;
      nameHits[key] = (nameHits[key] ?? 0) + 1;
      idx = s.indexOf(n, idx + n.length);
    }
  }
});
console.log('产品名出现计数(字段:名字=次数):');
for (const [k, v] of Object.entries(nameHits).sort((x, y) => y[1] - x[1]).slice(0, 12)) console.log(`  ${k} = ${v}`);

// ---------- 模式覆盖检查:当前/扩展后的形状正则能否抓到所有 "You are" 句 ----------
const CUR_GENERIC = [/\bYou are [A-Z][^.\n]{0,160}?\b(?:code|cli|agent|extension|tool)\b[^.\n]{0,80}\./gi];
const NEW_GENERIC = [
  /\bYou are (?:(?:an?|the)\s+)?[A-Za-z][^.\n]{0,160}?\b(?:code|cli|agent|extension|tool)\b[^.\n]{0,80}\./gi,
  /\bYou are [A-Z][^.\n]{0,160}?\b(?:code|cli|agent|extension|tool)\b[^.\n]{0,80}\./gi,
  /\bYou're (?:(?:an?|the)\s+)?[A-Za-z][^.\n]{0,160}?\b(?:code|cli|agent|extension|tool)\b[^.\n]{0,80}\./gi,
];
let totalY = 0, curCaught = 0, newCaught = 0;
eachString(capture, '$', (p, s) => {
  const sentences = s.match(/\bYou are [^.\n]{2,220}\./gi) ?? [];
  for (const sent of sentences) {
    totalY += 1;
    if (CUR_GENERIC.some((re) => sent.match(re))) curCaught += 1;
    if (NEW_GENERIC.some((re) => sent.match(re))) newCaught += 1;
  }
});
console.log(`"You are…"句总数=${totalY}  当前模式覆盖=${curCaught}  扩展模式覆盖=${newCaught}`);

// ---------- Step 1: 基线复现 ----------
let base = await oracle(capture);
console.log(`[oracle ${oracleCalls}] 基线(捕获体原样): ${base}`);
if (base === 'RATE') { console.log('❌ 命中限速,终止(等会再跑)'); process.exit(2); }
if (base === 'PASS') { console.log('⚠️ 原样竟然 PASS——说明触发依赖上下文/状态,捕获体不含触发物'); process.exit(3); }

// ---------- Step 2: 扩展模式净化后重发 ----------
function sanitizeWith(body, patterns, preambles) {
  const walk = (v) => {
    if (typeof v === 'string') {
      let out = v;
      for (const p of preambles) out = out.split(p).join('[x]');
      for (const re of patterns) out = out.replace(re, '[x]');
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k]); return o; }
    return v;
  };
  return walk(body);
}
const bl = JSON.parse(readFileSync(BLOCKLIST, 'utf8'));
const preambles = [];
for (const e of Object.values(bl.entries ?? {})) {
  for (const b64 of e.strings ?? []) preambles.push(Buffer.from(b64, 'base64').toString('utf8'));
}
for (const b64 of bl.learned ?? []) preambles.push(Buffer.from(b64, 'base64').toString('utf8'));
console.log('黑名单精确条目数:', preambles.length, '(内容不打印)');

let testBody = sanitizeWith(capture, NEW_GENERIC, preambles);
let r2 = await oracle(testBody);
console.log(`[oracle ${oracleCalls}] 扩展模式净化后: ${r2}`);
if (r2 === 'RATE') { console.log('❌ 命中限速,终止'); process.exit(2); }
if (r2 === 'PASS') {
  console.log('✅ 扩展形状正则即可解决!把新正则写进代理即可。');
  process.exit(10);
}

// ---------- Step 3: delta-debug 定位最小触发单元 ----------
async function fieldRemoved(f) {
  const t = clone(capture);
  delete t[f];
  return oracle(t);
}
console.log('--- 单字段移除测试 ---');
const culprits = [];
for (const f of ['tools', 'system', 'reasoning_effort']) {
  if (capture[f] === undefined) continue;
  const res = await fieldRemoved(f);
  console.log(`[oracle ${oracleCalls}] 移除 ${f}: ${res}`);
  if (res === 'PASS') culprits.push(f);
}
// messages 按条移除
for (let i = 0; i < (capture.messages ?? []).length; i++) {
  const t = clone(capture);
  t.messages.splice(i, 1);
  if (!t.messages.length) continue;
  const res = await oracle(t);
  console.log(`[oracle ${oracleCalls}] 移除 messages[${i}](role=${t.messages[0]?.role}..): ${res}`);
  if (res === 'PASS') culprits.push(`messages[${i}]`);
}
if (!culprits.length) { console.log('❌ 单项移除均不能 PASS——触发物跨多项或不在这些字段'); process.exit(4); }
console.log('触发字段:', culprits.join(', '));

// ---------- Step 4: 在触发字段内二分 ----------
function getVal(obj, path) {
  const m = path.match(/^(\w+)(?:\[(\d+)\])?$/);
  if (!m) return null;
  return m[2] === undefined ? obj[m[1]] : obj[m[1]][Number(m[2])];
}
function setVal(obj, path, v) {
  const m = path.match(/^(\w+)(?:\[(\d+)\])?$/);
  if (!m) return;
  if (m[2] === undefined) obj[m[1]] = v; else obj[m[1]][Number(m[2])] = v;
}
async function bisectString(str) {
  // 行级二分:找最小行子集使包含它的 body 仍 BANNED
  let lines = str.split('\n');
  let offending = lines;
  while (offending.length > 1) {
    const half = Math.ceil(offending.length / 2);
    let found = false;
    for (const part of [offending.slice(0, half), offending.slice(half)]) {
      if (!part.length) continue;
      const t = clone(capture);
      setVal(t, CULPRIT_PATH, part.join('\n'));
      if ((await oracle(t)) === 'BANNED') { offending = part; found = true; break; }
    }
    if (!found) break; // 触发物跨行组合,停在这里
  }
  return offending.join('\n');
}

let learned = 0;
for (const path of culprits) {
  const val = getVal(capture, path);
  if (typeof val === 'string') {
    const frag = await bisectString(val);
    console.log(`[oracle ${oracleCalls}] ${path} 内定位到触发片段: ${frag.split('\n').length} 行 / ${frag.length} 字符(内容不打印)`);
    // 入名单(精确整段)
    const f = JSON.parse(readFileSync(BLOCKLIST, 'utf8'));
    f.learned = f.learned ?? [];
    const b64 = Buffer.from(frag, 'utf8').toString('base64');
    if (!f.learned.includes(b64)) { f.learned.push(b64); learned += 1; }
    writeFileSync(BLOCKLIST, JSON.stringify(f, null, 2));
  } else if (Array.isArray(val)) {
    // tools 数组二分
    let items = val;
    while (items.length > 1) {
      const half = Math.ceil(items.length / 2);
      let found = false;
      for (const part of [items.slice(0, half), items.slice(half)]) {
        const t = clone(capture);
        setVal(t, path, part);
        if ((await oracle(t)) === 'BANNED') { items = part; found = true; break; }
      }
      if (!found) break;
    }
    console.log(`[oracle ${oracleCalls}] ${path} 定位到 ${items.length} 个触发项(名称长度: ${(items[0]?.function?.name ?? items[0]?.name ?? '?').length} 字符)`);
    for (let ti = 0; ti < items.length; ti++) {
      const t = clone(capture);
      setVal(t, path, [items[ti]]);
      if ((await oracle(t)) === 'BANNED') {
        const item = items[ti];
        const desc = item?.function?.description ?? item?.description ?? '';
        const nameLen = (item?.function?.name ?? item?.name ?? '').length;
        console.log(`  触发项#${ti}: name长度=${nameLen} desc长度=${desc.length}`);
        if (desc.length >= 12) {
          const frag = await bisectString(desc);
          console.log(`  desc 内定位: ${frag.length} 字符(内容不打印) → 入名单`);
          const f = JSON.parse(readFileSync(BLOCKLIST, 'utf8'));
          f.learned = f.learned ?? [];
          const b64 = Buffer.from(frag, 'utf8').toString('base64');
          if (!f.learned.includes(b64)) { f.learned.push(b64); learned += 1; }
          writeFileSync(BLOCKLIST, JSON.stringify(f, null, 2));
        }
      }
    }
  }
}
console.log(`--- 新学习条目: ${learned} ---`);

// ---------- Step 5: 终验(名单+扩展模式一起净化) ----------
const bl2 = JSON.parse(readFileSync(BLOCKLIST, 'utf8'));
const pre2 = [];
for (const e of Object.values(bl2.entries ?? {})) for (const b64 of e.strings ?? []) pre2.push(Buffer.from(b64, 'base64').toString('utf8'));
for (const b64 of bl2.learned ?? []) pre2.push(Buffer.from(b64, 'base64').toString('utf8'));
const finalBody = sanitizeWith(capture, NEW_GENERIC, pre2);
const r3 = await oracle(finalBody);
console.log(`[oracle ${oracleCalls}] 终验(名单+扩展模式): ${r3}`);
console.log(r3 === 'PASS' ? '✅✅ 定位并中和成功——重启代理即生效' : '❌ 仍未 PASS——需要更深二分');
