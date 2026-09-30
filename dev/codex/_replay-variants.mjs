// 变体验证:reasoning_content 应该挂在哪类 assistant 消息上
import fs from 'node:fs';
const AUTH_FILE = 'C:/Users/<USER>/AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info';
const CHAT = 'https://www.workbuddy.ai/v2/chat/completions';
const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
const authDoc = parsed.auth ?? parsed;
const identity = parsed.account ?? parsed;
const accessToken = authDoc.accessToken ?? '';
const uid = typeof identity.uid === 'string' ? identity.uid : '';
const domain = typeof authDoc.domain === 'string' ? authDoc.domain : '';
const cap = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = cap.body ?? cap;
for (let i = base.messages.length - 1; i >= 0; i--) {
  if (base.messages[i].role === 'user') { base.messages[i] = { role: 'user', content: '只回答:好' }; break; }
}
base.max_tokens = 32;
base.stream = true;
function headers() {
  return {
    'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest',
    'Origin': 'https://www.workbuddy.ai', 'Referer': 'https://www.workbuddy.ai/',
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2', 'Content-Type': 'application/json',
    ...(uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': uid }),
    ...(domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': domain }),
    'X-Product': 'SaaS', Authorization: `Bearer ${accessToken}`,
  };
}
const PLACEHOLDER = '(no reasoning content recorded for this turn)';
function variant(clone, mode) {
  let prevRc = '';
  for (const m of clone.messages) {
    if (m.role !== 'assistant') continue;
    const hasTools = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
    if (mode === 'C') { // 只挂 tool_calls 轮,内容取同轮前一条 assistant 的真实 rc
      if (hasTools) { if (!m.reasoning_content && prevRc) m.reasoning_content = prevRc; if (!m.reasoning_content) m.reasoning_content = PLACEHOLDER; }
      else delete m.reasoning_content;
    } else if (mode === 'D') { // 只挂 tool_calls 轮,占位
      if (hasTools) { if (!m.reasoning_content) m.reasoning_content = PLACEHOLDER; }
      else delete m.reasoning_content;
    } else if (mode === 'E') { // 全部剥掉(对照)
      delete m.reasoning_content;
    }
    if (m.reasoning_content) prevRc = m.reasoning_content;
  }
  return clone;
}
async function replay(label, clone) {
  const r = await fetch(CHAT, { method: 'POST', headers: headers(), body: JSON.stringify(clone), signal: AbortSignal.timeout(120000) });
  const raw = await r.text();
  const is11155 = raw.includes('11155') || raw.includes('reasoning_content_missing');
  const done = r.ok && (raw.includes('[DONE]') || raw.includes('finish_reason'));
  console.log(`[${label}] HTTP ${r.status} | ${is11155 ? '❌ 11155' : done ? '✅ 通过' : r.ok ? '✅ 200(流)' : raw.slice(0, 110).replace(/\s+/g, ' ')}`);
}
await replay('C rc只挂tool_calls轮+真实内容', variant(JSON.parse(JSON.stringify(base)), 'C'));
await replay('D rc只挂tool_calls轮+占位  ', variant(JSON.parse(JSON.stringify(base)), 'D'));
await replay('E 全剥掉(对照)             ', variant(JSON.parse(JSON.stringify(base)), 'E'));
