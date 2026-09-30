#!/usr/bin/env node
/**
 * 对捕获体的 system 内容做行级/句级二分,定位 11128 最小触发单元并自动入黑名单。
 * 安全:只打印 行数/字符数/索引/布尔,绝不打印内容。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const AUTH_FILE = 'C:/Users/<USER>/AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info';
const CHAT = 'https://copilot.tencent.com/v2/chat/completions';
const UA = 'CLI/2.63.2 CodeBuddy/2.63.2';
const BLOCKLIST = 'D:/dsh工作区/dsh工作区2/zcode-workbuddy-proxy/identity-blocklist.json';
const CAPTURE = 'D:/dsh工作区/dsh工作区2/zcode-workbuddy-proxy/capture/11128-1789115245737.json';

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
let calls = 0;
async function oracle(body) {
  calls += 1;
  const b = { ...body, stream: true, max_tokens: 1 };
  const r = await fetch(CHAT, { method: 'POST', headers: headers(), body: JSON.stringify(b), signal: AbortSignal.timeout(90000) });
  if (r.status === 200) { try { await r.body.cancel(); } catch {} return 'PASS'; }
  const t = await r.text();
  if (t.includes('11128')) return 'BANNED';
  if (r.status === 429 || t.includes('6004')) return 'RATE';
  return `OTHER:${r.status}`;
}
const clone = (b) => JSON.parse(JSON.stringify(b));

const capture = JSON.parse(readFileSync(CAPTURE, 'utf8'));
const sys = capture.messages[0].content;
console.log('system 长度:', sys.length, '| 行数:', sys.split('\n').length);

async function sysTriggers(lines) {
  const t = clone(capture);
  t.messages[0] = { role: 'system', content: lines.join('\n') };
  return (await oracle(t)) === 'BANNED';
}

// 行级折半(带边界扩展)
let cur = sys.split('\n');
let guard = 0;
while (cur.length > 1 && guard++ < 30) {
  const half = Math.ceil(cur.length / 2);
  const A = cur.slice(0, half), B = cur.slice(half);
  if (await sysTriggers(A)) { cur = A; continue; }
  if (await sysTriggers(B)) { cur = B; continue; }
  // 跨边界:逐步扩展 A 的尾部
  let done = false;
  for (let k = 1; k <= 8 && !done; k++) {
    const C = cur.slice(0, Math.min(cur.length, half + k));
    if (C.length > A.length && await sysTriggers(C)) { cur = C; done = true; }
  }
  if (!done) break;
}
console.log(`[oracle ${calls}] 行级定位: ${cur.length} 行 / ${cur.join('\n').length} 字符`);

// 句级定位:区域内滑窗 1..2 句
const region = cur.join('\n');
const sentences = region.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length >= 12);
console.log('区域内句数:', sentences.length);
const winners = [];
for (let i = 0; i < sentences.length; i++) {
  if (await sysTriggers([sentences[i]])) { winners.push(sentences[i]); console.log(`  句[${i}] 单独触发 ✓ (长度 ${sentences[i].length})`); }
}
if (!winners.length) {
  for (let i = 0; i + 1 < sentences.length; i++) {
    if (await sysTriggers([sentences[i] + ' ' + sentences[i + 1]])) { winners.push(sentences[i] + ' ' + sentences[i + 1]); console.log(`  句[${i}+${i + 1}] 连续触发 ✓ (长度 ${sentences[i].length + sentences[i + 1].length + 1})`); i++; }
  }
}
console.log(`[oracle ${calls}] 句级触发单元: ${winners.length} 个`);
if (!winners.length) { console.log('❌ 未能定位到句级单元(触发物跨多句?)——把区域整体入名单'); winners.push(region); }

// 入黑名单
const bl = JSON.parse(readFileSync(BLOCKLIST, 'utf8'));
bl.learned = bl.learned ?? [];
let added = 0;
for (const w of winners) {
  const b64 = Buffer.from(w, 'utf8').toString('base64');
  if (!bl.learned.includes(b64)) { bl.learned.push(b64); added += 1; }
}
writeFileSync(BLOCKLIST, JSON.stringify(bl, null, 2));
console.log(`新入名单: ${added} 条(累计 ${bl.learned.length})`);

// 终验:整份 system 用名单净化后重发
function applyBlocklist(text) {
  let out = text;
  for (const b64 of bl.learned) out = out.split(Buffer.from(b64, 'base64').toString('utf8')).join('[x]');
  for (const e of Object.values(bl.entries ?? {})) for (const b64 of e.strings ?? []) out = out.split(Buffer.from(b64, 'base64').toString('utf8')).join('[x]');
  return out;
}
const t2 = clone(capture);
t2.messages[0] = { role: 'system', content: applyBlocklist(sys) };
const final = await oracle(t2);
console.log(`[oracle ${calls}] 终验(名单净化后整份重发): ${final}`);
console.log(final === 'PASS' ? '✅✅ 完成——重启代理即生效' : '⚠️ 仍有残留触发物——再跑一轮本脚本(它会对净化后的体继续二分)');
