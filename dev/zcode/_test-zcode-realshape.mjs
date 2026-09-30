// 复现 ZCode 真实请求形态:多文本块 user 消息(含 <system-reminder>)+ system 数组 + tools + 流式
const BASE = 'http://127.0.0.1:8400/v1/messages';

const body = {
  model: 'glm-5.3-flash',
  stream: true,
  max_tokens: 300,
  system: [
    { type: 'text', text: 'You are a coding agent. Answer briefly in Chinese.', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Additional guidance block for testing.' },
  ],
  tools: [{
    name: 'get_weather',
    description: '查询城市天气',
    input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  }],
  tool_choice: { type: 'auto' },
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n- agently-mail: 通过 agently-cli 命令行工具操作邮件。当用户需要进行任何邮件相关操作时使用此 skill。\n</system-reminder>' },
      { type: 'text', text: '北京今天天气怎么样?如果需要查天气请调用工具。', cache_control: { type: 'ephemeral' } },
    ],
  }],
};

const r = await fetch(BASE, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': 'zcode-workbuddy', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(120000),
});
console.log('HTTP', r.status);
const raw = await r.text();
if (r.status !== 200) { console.log(raw.slice(0, 600)); process.exit(1); }

let text = '', thinking = 0, toolName = '', toolArgs = '';
for (const line of raw.split('\n')) {
  if (!line.startsWith('data:')) continue;
  const p = line.slice(5).trim();
  if (!p || p === '[DONE]') continue;
  try {
    const ev = JSON.parse(p);
    if (ev.type === 'content_block_start') {
      if (ev.content_block?.type === 'tool_use') toolName = ev.content_block.name;
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta ?? {};
      if (d.type === 'text_delta') text += d.text ?? '';
      if (d.type === 'thinking_delta') thinking++;
      if (d.type === 'input_json_delta') toolArgs += d.partial_json ?? '';
    }
  } catch {}
}
console.log('thinking_delta 事件数:', thinking);
console.log('tool_use:', toolName || '(无)', toolArgs ? 'args=' + toolArgs.slice(0, 80) : '');
console.log('text:', text.slice(0, 220).replace(/\s+/g, ' '));
console.log(text || toolName ? '\n✅ 修复验证通过' : '\n❌ 无任何产出');
