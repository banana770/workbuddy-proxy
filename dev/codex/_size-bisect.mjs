// 规模二分:全占位结构 + 单条 user 消息膨胀到 N 字符,找思维链模式的真实上下文阈值
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
const full = cap.body ?? cap;
function shrinkKeepIds(m) {
  const out = { role: m.role, content: typeof m.content === 'string' ? 'x' : (m.content === null ? null : [{ type: 'text', text: 'x' }]) };
  if (Array.isArray(m.tool_calls)) out.tool_calls = m.tool_calls;
  if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
  return out;
}
const shrunk = full.messages.map(shrinkKeepIds);
async function replayInflated(nChars) {
  const ms = shrunk.slice();
  ms.push({ role: 'user', content: 'x'.repeat(nChars) });
  ms.push({ role: 'user', content: '只回答:好' });
  const body = { model: full.model, messages: ms, stream: true, max_tokens: 16, ...(full.reasoning_effort ? { reasoning_effort: full.reasoning_effort } : {}) };
  if (Array.isArray(full.tools)) body.tools = full.tools;
  const r = await fetch(CHAT, {
    method: 'POST',
    headers: {
      'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://www.workbuddy.ai', 'Referer': 'https://www.workbuddy.ai/',
      'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2', 'Content-Type': 'application/json',
      ...(uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': uid }),
      ...(domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': domain }),
      'X-Product': 'SaaS', Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body), signal: AbortSignal.timeout(240000),
  });
  const raw = await r.text();
  const bad = raw.includes('11155') || raw.includes('reasoning_content_missing');
  const tokens = Math.round((nChars + 2000) / 2.2);
  console.log(`膨胀 ${nChars} 字符 (≈${tokens} tokens) → HTTP ${r.status} ${bad ? '❌11155' : r.ok ? '✅' : raw.slice(0, 70).replace(/\s+/g, ' ')}`);
}
for (const n of [50000, 150000, 400000]) await replayInflated(n);
