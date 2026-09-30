// 8403 工具调用形态的 11155 A/B:真实 agentic 会话 = user → reasoning → function_call → function_call_output → assistant
const URL = 'http://127.0.0.1:8403/v1/responses';
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer workbuddy-local-proxy' };

async function probe(label, input) {
  const r = await fetch(URL, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash', stream: true,
      reasoning: { effort: 'high', summary: 'auto' },
      tools: [{ type: 'function', name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      input,
    }),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await r.text();
  const isErr = raw.includes('11155') || raw.includes('reasoning_content_missing');
  const done = raw.includes('response.completed');
  console.log(`[${label}] HTTP ${r.status} | ${isErr ? '❌ 11155 reasoning_content_missing' : done ? '✅ 正常完成' : raw.slice(0, 100).replace(/\s+/g, ' ')}`);
}

const u1 = { type: 'message', role: 'user', content: [{ type: 'input_text', text: '读一下 D:/test.txt 的内容' }] };
const u2 = { type: 'message', role: 'user', content: [{ type: 'input_text', text: '读完了吗?只回答:读到了' }] };
const fc = { type: 'function_call', call_id: 'call_001', name: 'read_file', arguments: '{"path":"D:/test.txt"}' };
const fo = { type: 'function_call_output', call_id: 'call_001', output: 'hello world' };
const asstText = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '读到了' }] };

// A:工具轮的 reasoning 不回放(修复前的行为)
await probe('A 工具轮无reasoning', [u1, fc, fo, asstText, u2]);
// B:工具轮的 reasoning 回放(修复后的行为:reasoning 挂到 flush 出的 assistant tool_calls 消息上)
await probe('B 工具轮带reasoning', [u1, { type: 'reasoning', summary: [{ type: 'summary_text', text: '用户要读文件,调用 read_file。' }] }, fc, fo, asstText, u2]);
