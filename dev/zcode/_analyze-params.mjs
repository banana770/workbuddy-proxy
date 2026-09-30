// 静态分析捕获的失败请求体:只看顶层参数与消息规模(内容打码),定位被拒参数
import fs from 'node:fs';
const files = process.argv.slice(2);
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const b = d.body ?? d;
  console.log('━━━', f.split(/[\\/]/).pop());
  if (d.at) console.log('  时间:', d.at);
  const msgKeys = new Set();
  let totalChars = 0;
  let withRc = 0, withTc = 0;
  for (const m of (b.messages ?? [])) {
    for (const k of Object.keys(m)) msgKeys.add(k);
    const c = m.content;
    totalChars += typeof c === 'string' ? c.length : Array.isArray(c) ? JSON.stringify(c).length : 0;
    if (m.reasoning_content) withRc++;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) withTc++;
  }
  console.log('  顶层参数:');
  for (const [k, v] of Object.entries(b)) {
    if (k === 'messages' || k === 'tools') continue;
    const shown = typeof v === 'string' && v.length > 60 ? `<str:${v.length}>` : JSON.stringify(v);
    console.log(`    ${k}: ${shown}`);
  }
  console.log(`    messages: ${(b.messages ?? []).length} 条 | 内容总字符 ${totalChars} | 带reasoning_content ${withRc} 条 | 带tool_calls ${withTc} 条`);
  console.log(`    messages 里出现过的键: ${[...msgKeys].join(', ')}`);
  if (Array.isArray(b.tools)) console.log(`    tools: ${b.tools.length} 个`);
  console.log('');
}
