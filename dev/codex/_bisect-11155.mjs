// 结构二分:内容全部置为占位,保留角色/结构,截断到前 N 条+结尾 user,找 11155 的触发点
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

function shrink(m) {
  const out = { role: m.role, content: typeof m.content === 'string' ? 'x' : (m.content === null ? null : [{ type: 'text', text: 'x' }]) };
  if (Array.isArray(m.tool_calls)) out.tool_calls = m.tool_calls.map((t) => ({ id: t.id ?? 'call_x', type: 'function', function: { name: t.function?.name ?? 'f', arguments: '{}' } }));
  if (m.reasoning_content !== undefined) out.reasoning_content = 'x';
  return out;
}
// 关键:tool_calls 的 id 与 tool 消息的 tool_call_id 必须原样保留,否则 11148 配对失败
function shrinkKeepIds(m) {
  const out = { role: m.role, content: typeof m.content === 'string' ? 'x' : (m.content === null ? null : [{ type: 'text', text: 'x' }]) };
  if (Array.isArray(m.tool_calls)) out.tool_calls = m.tool_calls;
  if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
  if (m.reasoning_content !== undefined) out.reasoning_content = 'x';
  return out;
}
const shrunkFull = full.messages.map(shrinkKeepIds);

async function replay(prefixN) {
  const ms = shrunkFull.slice(0, prefixN);
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
    body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
  });
  const raw = await r.text();
  const bad = raw.includes('11155') || raw.includes('reasoning_content_missing');
  return `HTTP ${r.status} ${bad ? '❌11155' : r.ok ? '✅' : raw.slice(0, 60).replace(/\s+/g, ' ')}`;
}

console.log('model:', full.model, '| reasoning_effort:', full.reasoning_effort, '| 总消息:', shrunkFull.length);
for (const n of [4, 12, 30, 45, 55, 60, 63, 64]) {
  console.log(`前 ${n} 条 + 结尾user →`, await replay(n));
}
