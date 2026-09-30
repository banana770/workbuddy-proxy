// 11155 修复验证:思维链模式下,上一轮 reasoning_content 回传 vs 不回传
const H = { 'Content-Type': 'application/json', 'x-api-key': 'zcode-workbuddy', 'anthropic-version': '2023-06-01' };
const URL = 'http://127.0.0.1:8400/v1/messages';
const base = { model: 'deepseek-v4.1-flash', max_tokens: 512, stream: false, thinking: { type: 'enabled', budget_tokens: 2048 } };

async function probe(label, messages) {
  const r = await fetch(URL, { method: 'POST', headers: H, body: JSON.stringify({ ...base, messages }), signal: AbortSignal.timeout(120000) });
  const raw = await r.text();
  let head = '';
  try { const j = JSON.parse(raw); head = j.error ? `400 ${j.error.message?.slice(0, 90)}` : `200 "${(j.content?.find(b => b.type === 'text')?.text ?? '').slice(0, 30)}"`; }
  catch { head = raw.slice(0, 90); }
  console.log(`[${label}] HTTP ${r.status} → ${head}`);
}

const user1 = { role: 'user', content: '2+2等于几?只回答数字' };
const user2 = { role: 'user', content: '那再乘以10呢?只回答数字' };

// A:上一轮助手消息不带 thinking(复现用户遇到的 11155)
await probe('A 无thinking回传', [user1, { role: 'assistant', content: [{ type: 'text', text: '4' }] }, user2]);
// B:上一轮助手消息带 thinking 块(修复后应成功)
await probe('B 带thinking回传 ', [user1, { role: 'assistant', content: [{ type: 'thinking', thinking: '2+2=4,用户接着要乘10。' }, { type: 'text', text: '4' }] }, user2]);
