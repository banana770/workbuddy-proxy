// 全量真实内容重放 + 逐消息内容替换定位触发器(输出只含状态与位置,不打印内容)
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
const body = cap.body ?? cap;
for (let i = body.messages.length - 1; i >= 0; i--) {
  if (body.messages[i].role === 'user') { body.messages[i] = { role: 'user', content: '只回答:好' }; break; }
}
body.max_tokens = 32;
body.stream = true;
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
async function go(label, clone) {
  const r = await fetch(CHAT, { method: 'POST', headers: headers(), body: JSON.stringify(clone), signal: AbortSignal.timeout(120000) });
  const raw = await r.text();
  const bad = raw.includes('11155') || raw.includes('reasoning_content_missing');
  console.log(`[${label}] HTTP ${r.status} ${bad ? '❌11155' : r.ok ? '✅' : raw.slice(0, 80).replace(/\s+/g, ' ')}`);
  return !bad;
}
// 全量真实内容(基线,应复现 11155)
await go('全量真实内容(基线)', JSON.parse(JSON.stringify(body)));
// 逐条:把第 i 条消息内容替换为 'x',其余保持真实 → 若变绿,触发器在第 i 条
const idx = process.argv[3] !== undefined ? Number(process.argv[3]) : -1;
if (idx >= 0) {
  const c = JSON.parse(JSON.stringify(body));
  const m = c.messages[idx];
  m.content = typeof m.content === 'string' ? 'x' : (m.content === null ? null : [{ type: 'text', text: 'x' }]);
  delete m.reasoning_content;
  if (Array.isArray(m.tool_calls)) delete m.tool_calls;
  await go(`仅第 ${idx} 条替换为占位`, c);
} else {
  for (const i of [0, 1, 2, 3]) {
    const c = JSON.parse(JSON.stringify(body));
    const m = c.messages[i];
    m.content = typeof m.content === 'string' ? 'x' : (m.content === null ? null : [{ type: 'text', text: 'x' }]);
    delete m.reasoning_content;
    if (Array.isArray(m.tool_calls)) delete m.tool_calls;
    await go(`替换第 ${i} 条(${m.role})内容`, c);
  }
}
