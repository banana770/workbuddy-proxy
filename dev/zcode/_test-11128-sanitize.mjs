// 11128 清洗端到端测试:运行时解码被禁原文注入请求(内容绝不打印),预期清洗后 200
import { readFileSync } from 'node:fs';

const bl = JSON.parse(readFileSync(new URL('./identity-blocklist.json', import.meta.url), 'utf8'));
let banned = null;
for (const e of Object.values(bl.entries ?? {})) {
  for (const b64 of e.strings ?? []) { banned = Buffer.from(b64, 'base64').toString('utf8'); break; }
  if (banned) break;
}
if (!banned) { console.log('❌ blocklist 为空'); process.exit(1); }
console.log('注入被禁原文:长度', banned.length, '字符(内容不打印)');

const body = {
  model: 'glm-5.3-flash',
  stream: true,
  max_tokens: 60,
  system: [{ type: 'text', text: 'Agent rules.\n\n' + banned + '\n\nAnswer briefly in Chinese.' }],
  tools: [{ name: 'echo', description: 'echo the text', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '<system-reminder>skills list placeholder</system-reminder>' },
      { type: 'text', text: '把下面这句原样写进 echo 工具的参数里:' + banned },
    ],
  }],
};

const r = await fetch('http://127.0.0.1:8400/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': 'zcode-workbuddy', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(90000),
});
console.log('HTTP', r.status);
if (r.status !== 200) {
  const t = await r.text();
  const code = (t.match(/"code":(\d+)/) ?? [])[1] ?? '?';
  console.log(`❌ 失败,上游 code=${code}(若是 11128 说明清洗未生效;原始响应不打印)`);
  process.exit(1);
}
console.log('✅ 11128 清洗生效:system 注入 + 工具参数注入被禁原文,均被代理清洗,上游返回 200');
