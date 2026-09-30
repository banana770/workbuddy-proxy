// 内容二分:[57] 的真实 reasoning_content 逐段截断,找出触发 11155 的字符区间;并输出敏感词计数
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
// 找 [57] 对应位置(第一条带 reasoning_content 的 assistant)与 [61](第二条)
const rcIdx = [];
full.messages.forEach((m, i) => { if (m.role === 'assistant' && m.reasoning_content) rcIdx.push(i); });
const rc57 = full.messages[rcIdx[0]].reasoning_content;
const rc61 = full.messages[rcIdx[1]]?.reasoning_content ?? '';
console.log('rc57 长度:', rc57.length, '| rc61 长度:', rc61.length);

// 敏感词计数(只输出数量)
const words = ['Claude', 'claude', 'GPT', 'gpt', 'OpenAI', 'openai', 'Gemini', 'gemini', 'Gemini', 'Anthropic', 'anthropic', 'DSH', 'DeepSeek Harness', 'WorkBuddy', 'Qwen', 'kimi', 'Kimi'];
console.log('rc57 词频:', words.map((w) => `${w}:${(rc57.match(new RegExp(w, 'g')) ?? []).length}`).filter((s) => !s.endsWith(':0')).join(' ') || '(无)');
console.log('rc61 词频:', words.map((w) => `${w}:${(rc61.match(new RegExp(w, 'g')) ?? []).length}`).filter((s) => !s.endsWith(':0')).join(' ') || '(无)');

async function replayWith(rc57Value, rc61Value) {
  const ms = shrunk.map((m) => ({ ...m }));
  if (rcIdx[0] !== undefined) ms[rcIdx[0]].reasoning_content = rc57Value;
  if (rcIdx[1] !== undefined && rc61Value !== undefined) ms[rcIdx[1]].reasoning_content = rc61Value;
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
  return `HTTP ${r.status} ${bad ? '❌11155' : r.ok ? '✅' : raw.slice(0, 70).replace(/\s+/g, ' ')}`;
}

// 长度二分:rc57 全量 → 逐步截短
console.log('rc57 全量      →', await replayWith(rc57, 'x'));
console.log('rc61 真实+rc57占位 →', await replayWith('x', rc61));
for (const len of [8000, 6000, 4000, 2000, 1000, 500, 200]) {
  console.log(`rc57 前 ${len} 字  →`, await replayWith(rc57.slice(0, len), 'x'));
}
