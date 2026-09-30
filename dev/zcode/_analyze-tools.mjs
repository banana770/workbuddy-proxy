// 从捕获体里挖「参数类」嫌疑:tools schema 关键字、消息异常、其他顶层结构
import fs from 'node:fs';
const f = process.argv[2];
const d = JSON.parse(fs.readFileSync(f, 'utf8'));
const b = d.body ?? d;

const SAFE = new Set(['type', 'properties', 'required', 'description', 'items', 'enum', 'title', 'default', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'nullable', 'additionalProperties', 'format', 'pattern', 'anyOf', 'oneOf', 'allOf', 'const', 'examples', 'example', '$ref', '$defs', 'definitions', 'strict', 'propertyOrdering', 'additionalItems', 'uniqueItems', 'multipleOf', 'exclusiveMinimum', 'exclusiveMaximum']);

function walk(node, found, path = '') {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n, i) => walk(n, found, `${path}[${i}]`)); return; }
  for (const [k, v] of Object.entries(node)) {
    found.set(k, (found.get(k) ?? 0) + 1);
    walk(v, found, `${path}.${k}`);
  }
}

const tools = b.tools ?? [];
console.log('工具数:', tools.length);
const names = [];
const kw = new Map();
const odd = [];
for (const t of tools) {
  const fn = t.function ?? t;
  names.push(fn.name);
  if (t.type !== 'function') odd.push(`tool.type=${t.type} (${fn.name})`);
  const params = fn.parameters;
  if (!params || typeof params !== 'object') { odd.push(`无 parameters: ${fn.name}`); continue; }
  walk(params, kw);
  if (params.type !== 'object') odd.push(`parameters.type=${params.type}: ${fn.name}`);
}
console.log('工具名:', names.join(', '));
console.log('\n工具 schema 中出现的全部关键字:');
console.log('  ' + [...kw.keys()].sort().join(', '));
const unknown = [...kw.keys()].filter((k) => !SAFE.has(k));
console.log('\n不在已知安全清单里的关键字:', unknown.length ? unknown.join(', ') : '(无)');
console.log('\n结构化异常:', odd.length ? odd.join(' | ') : '(无)');

// 消息层异常
const ms = b.messages ?? [];
const roles = new Map();
let emptyContent = 0, withRc = 0, tcIds = 0;
const badRc = [];
for (const m of ms) {
  roles.set(m.role, (roles.get(m.role) ?? 0) + 1);
  const hasContent = typeof m.content === 'string' ? m.content.length > 0 : Array.isArray(m.content) && m.content.length > 0;
  if (!hasContent && !(Array.isArray(m.tool_calls) && m.tool_calls.length)) emptyContent++;
  if (typeof m.reasoning_content === 'string') { withRc++; if (m.reasoning_content.length > 20000) badRc.push(m.reasoning_content.length); }
  if (Array.isArray(m.tool_calls)) tcIds += m.tool_calls.length;
}
console.log('\n消息角色分布:', [...roles.entries()].map(([r, n]) => `${r}×${n}`).join(', '));
console.log('空 content 且无 tool_calls 的消息:', emptyContent, '| 带 reasoning_content:', withRc, '| tool_calls 总数:', tcIds);
if (badRc.length) console.log('⚠️ 超长 reasoning_content:', badRc.join(', '));
console.log('\n顶层:', Object.keys(b).map((k) => `${k}=${k === 'messages' || k === 'tools' ? '…' : JSON.stringify(b[k])}`).join(' | '));
