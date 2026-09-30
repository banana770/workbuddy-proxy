import fs from 'node:fs';
const files = process.argv.slice(2);
const mask = (v) => (typeof v === 'string' ? (v.length <= 24 ? v : `<str:${v.length}>`) : v);
function brief(o, depth = 0) {
  if (depth > 3) return '…';
  if (o === null || typeof o !== 'object') return mask(o);
  if (Array.isArray(o)) return `[${o.length}] ` + o.slice(0, 2).map((x) => brief(x, depth + 1)).join(' | ');
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = brief(v, depth + 1);
  return out;
}
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const b = d.body ?? d;
  console.log('━━━', f.split(/[\\/]/).pop(), '| at', d.at);
  console.log('  model:', b.model, '| reasoning_effort:', JSON.stringify(b.reasoning_effort), '| stream:', b.stream, '| tools:', Array.isArray(b.tools) ? b.tools.length : 0);
  const ms = b.messages ?? [];
  console.log('  messages:', ms.length);
  ms.forEach((m, i) => {
    const role = m.role;
    const content = typeof m.content === 'string' ? `str:${m.content.length}` : Array.isArray(m.content) ? `parts:${m.content.length}` : String(m.content);
    const tc = Array.isArray(m.tool_calls) ? `tool_calls×${m.tool_calls.length}` : '';
    const rc = 'reasoning_content' in m ? (m.reasoning_content == null ? 'null' : `rc:${String(m.reasoning_content).length}`) : '';
    console.log(`   [${i}] ${role.padEnd(9)} content=${String(content).padEnd(12)} ${tc} ${rc}`);
  });
  // 最后一条 assistant 的细节
  for (let i = ms.length - 1; i >= 0; i--) {
    if (ms[i].role === 'assistant') {
      console.log('  最后一条 assistant [' + i + ']:', JSON.stringify(brief({ content: ms[i].content, reasoning_content: ms[i].reasoning_content === undefined ? '(无字段)' : '有', tool_calls: ms[i].tool_calls?.length }), null, 0).slice(0, 400));
      break;
    }
  }
  console.log('');
}
