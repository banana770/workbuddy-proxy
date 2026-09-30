// 国际版(workbuddy.ai)反代端到端验证:zcode 侧 8402 (Anthropic) + codex 侧 8403 (OpenAI chat)
const H_A = { 'Content-Type': 'application/json', 'x-api-key': 'zcode-workbuddy-ai', 'anthropic-version': '2023-06-01' };

async function zcode(model) {
  const r = await fetch('http://127.0.0.1:8402/v1/messages', {
    method: 'POST', headers: H_A,
    body: JSON.stringify({ model, stream: true, max_tokens: 40, messages: [{ role: 'user', content: '只回答一个字:好' }] }),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await r.text();
  let text = '', thinking = 0;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const p = line.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try { const ev = JSON.parse(p);
      if (ev.type === 'content_block_delta') { if (ev.delta?.type === 'text_delta') text += ev.delta.text ?? ''; if (ev.delta?.type === 'thinking_delta') thinking++; }
    } catch {}
  }
  console.log(`[8402 zcode] ${model.padEnd(18)} HTTP ${r.status}  thinking增量=${thinking}  文本="${text.slice(0, 60)}"`);
  if (r.status !== 200) console.log('   ', raw.slice(0, 200).replace(/\s+/g, ' '));
}

async function codex(model) {
  const r = await fetch('http://127.0.0.1:8403/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer workbuddy-local-proxy' },
    body: JSON.stringify({ model, stream: false, max_tokens: 40, messages: [{ role: 'user', content: '只回答一个字:好' }] }),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await r.text();
  let text = '';
  try { const j = JSON.parse(raw); text = j.choices?.[0]?.message?.content ?? j.choices?.[0]?.message?.reasoning_content ?? ''; } catch {}
  console.log(`[8403 codex] ${model.padEnd(18)} HTTP ${r.status}  文本="${String(text).slice(0, 60)}"`);
  if (r.status !== 200) console.log('   ', raw.slice(0, 200).replace(/\s+/g, ' '));
}

await zcode('default-model');
await zcode('gpt-5.6-sol');
await codex('default-model');
await codex('gpt-5.3-codex');
