// 逐模型实测 8400 反代:按 ZCode 真实形态(带 thinking 块)发请求
const BASE = 'http://127.0.0.1:8400/v1/messages';
const MODELS = ['auto','hy4-preview','hy3','hy3-x','deepseek-v4.1-flash','glm-5.3','glm-5.3-flash','glm-5.2','glm-5.1','glm-5v-turbo','kimi-k3-1','kimi-k2.7','kimi-k2.6','minimax-m3','deepseek-v4-pro'];

async function test(model, withThinking) {
  const body = { model, max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] };
  if (withThinking) body.thinking = { type: 'enabled', budget_tokens: 1024 };
  try {
    const r = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'zcode-workbuddy', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    const t = await r.text();
    let short = t.replace(/\s+/g, ' ').slice(0, 220);
    if (r.status === 200) {
      let ok = '?';
      try { const j = JSON.parse(t); ok = (j.content || []).map(c => c.type).join('+') || '(empty)'; } catch {}
      console.log(`[${withThinking ? 'think' : 'plain'}] ${model.padEnd(20)} 200 OK content=${ok}`);
    } else {
      console.log(`[${withThinking ? 'think' : 'plain'}] ${model.padEnd(20)} HTTP ${r.status}  ${short}`);
    }
  } catch (e) {
    console.log(`[${withThinking ? 'think' : 'plain'}] ${model.padEnd(20)} ERR ${String(e).slice(0, 120)}`);
  }
}

const only = process.argv[2] ? process.argv[2].split(',') : null;
for (const m of (only ?? MODELS)) {
  await test(m, false);
  await test(m, true);
}
