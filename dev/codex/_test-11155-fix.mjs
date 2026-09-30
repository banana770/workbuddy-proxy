// 8403 (codex/Responses) 11155 A/B:带 reasoning 项回传 vs 不带
const URL = 'http://127.0.0.1:8403/v1/responses';
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer workbuddy-local-proxy' };

async function probe(label, input) {
  const r = await fetch(URL, {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, reasoning: { effort: 'high', summary: 'auto' }, input }),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await r.text();
  const isErr = raw.includes('11155') || raw.includes('reasoning_content_missing');
  const done = raw.includes('response.completed');
  console.log(`[${label}] HTTP ${r.status} | ${isErr ? '❌ 11155 reasoning_content_missing' : done ? '✅ 正常完成' : raw.slice(0, 80).replace(/\s+/g, ' ')}`);
}

const u1 = { type: 'message', role: 'user', content: [{ type: 'input_text', text: '2+2等于几?只回答数字' }] };
const u2 = { type: 'message', role: 'user', content: [{ type: 'input_text', text: '那再乘以10呢?只回答数字' }] };
const asstText = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '4' }] };

// A:历史里不回放 reasoning 项(修复前的行为)
await probe('A 无reasoning回传', [u1, asstText, u2]);
// B:历史里回放 reasoning 项(summary 摘要,修复后的行为)
await probe('B 带reasoning回传 ', [
  u1,
  { type: 'reasoning', summary: [{ type: 'summary_text', text: '2+2=4,用户接着要乘10。' }] },
  asstText,
  u2,
]);
