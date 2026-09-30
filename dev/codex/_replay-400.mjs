// 用捕获的 400 请求体做 A/B 重放:控制组(原样,应 11155) vs 修复组(补全 reasoning_content,应 200)
// 只输出 HTTP 状态与错误码,不打印任何消息内容。
import fs from 'node:fs';
import { homedir } from 'node:os';

const AUTH_FILE = 'C:/Users/<USER>/AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info';
const CAP = process.argv[2];
const CHAT = 'https://www.workbuddy.ai/v2/chat/completions';

const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
const authDoc = parsed.auth ?? parsed;
const identity = parsed.account ?? parsed;
const accessToken = authDoc.accessToken ?? '';
const uid = typeof identity.uid === 'string' ? identity.uid : '';
const domain = typeof authDoc.domain === 'string' ? authDoc.domain : '';
const cap = JSON.parse(fs.readFileSync(CAP, 'utf8'));
const body = cap.body ?? cap;

function headers() {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': 'https://www.workbuddy.ai',
    'Referer': 'https://www.workbuddy.ai/',
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    'Content-Type': 'application/json',
    ...(uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': uid }),
    ...(domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': domain }),
    'X-Product': 'SaaS',
    Authorization: `Bearer ${accessToken}`,
  };
}

// 把最后一条 user 消息换成极小指令 + 限制输出,控制重放成本
const msgs = body.messages;
for (let i = msgs.length - 1; i >= 0; i--) {
  if (msgs[i].role === 'user') { msgs[i] = { role: 'user', content: '只回答:好' }; break; }
}
body.max_tokens = 32;
body.stream = true; // 网关只支持流式(11101)

async function replay(label, fill) {
  const clone = JSON.parse(JSON.stringify(body));
  if (fill) {
    for (const m of clone.messages) {
      if (m.role === 'assistant' && !m.reasoning_content) m.reasoning_content = '(no reasoning content recorded for this turn)';
    }
  }
  const r = await fetch(CHAT, { method: 'POST', headers: headers(), body: JSON.stringify(clone), signal: AbortSignal.timeout(120000) });
  const raw = await r.text();
  const is11155 = raw.includes('11155') || raw.includes('reasoning_content_missing');
  const isCredit = raw.includes('14018') || /credits? exhausted/i.test(raw);
  console.log(`[${label}] HTTP ${r.status} | ${is11155 ? '❌ 11155 reasoning_content_missing' : isCredit ? '⚠️ 14018 Credits exhausted' : r.ok ? '✅ 通过' : raw.slice(0, 120).replace(/\s+/g, ' ')}`);
}

await replay('控制组 原样(预期11155)', false);
await replay('修复组 补全rc(预期200) ', true);
