// 抓一份代理发给客户端的原始 SSE,检查 thinking 部分的事件帧与增量形态(输出打码:每事件只打事件名+delta 长度)
const body = {
  model: 'glm-5.3-flash',
  stream: true,
  max_tokens: 120,
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '<system-reminder>skills placeholder</system-reminder>' },
      { type: 'text', text: '用两句话解释为什么天空是蓝色的。' },
    ],
  }],
};
const r = await fetch('http://127.0.0.1:8400/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': 'zcode-workbuddy', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(120000),
});
console.log('HTTP', r.status);
const raw = await r.text();
const lines = raw.split('\n').filter((l) => l.trim());
console.log('总 SSE 行数:', lines.length);
let thinkLen = 0, textLen = 0, blocks = [];
for (const l of lines) {
  if (l.startsWith('event:')) { blocks.push(l.slice(6).trim()); continue; }
  if (!l.startsWith('data:')) continue;
  try {
    const o = JSON.parse(l.slice(5));
    if (o.type === 'content_block_delta') {
      if (o.delta?.type === 'thinking_delta') { thinkLen += (o.delta.thinking ?? '').length; }
      if (o.delta?.type === 'text_delta') { textLen += (o.delta.text ?? '').length; }
    }
    if (o.type === 'content_block_start') blocks.push(`start:${o.content_block?.type}@${o.index}`);
    if (o.type === 'content_block_stop') blocks.push(`stop@${o.index}`);
  } catch {}
}
console.log('thinking 总长:', thinkLen, '| text 总长:', textLen);
console.log('事件序列(压缩):');
const seq = [];
for (const b of blocks) { if (seq.length && seq[seq.length - 1] === b) seq[seq.length - 1] = b + 'xN'; else if (seq.length && seq[seq.length - 1].replace('xN','') === b) seq[seq.length-1] = b + 'xN'; else seq.push(b); }
console.log('  ' + seq.join(' → '));
// 检查:thinking_delta 事件数 vs 单词数
let thinkDeltas = 0, emptyDeltas = 0;
for (const l of lines) {
  if (!l.startsWith('data:')) continue;
  try { const o = JSON.parse(l.slice(5)); if (o.delta?.type === 'thinking_delta') { thinkDeltas++; if (!o.delta.thinking) emptyDeltas++; } } catch {}
}
console.log('thinking_delta 事件数:', thinkDeltas, '| 空增量:', emptyDeltas, '| 平均每增量字符:', (thinkLen / Math.max(1, thinkDeltas)).toFixed(1));
