// 穷举体检:工具 schema 的所有非标准构造 + 消息层异常 + 尺寸
import fs from 'node:fs';
const f = process.argv[2];
const d = JSON.parse(fs.readFileSync(f, 'utf8'));
const b = d.body ?? d;
const issues = [];
const stats = {};

/* ---------- 工具 schema ---------- */
const KNOWN_FORMATS = new Set(['date-time', 'date', 'time', 'duration', 'email', 'idn-email', 'hostname', 'idn-hostname', 'ipv4', 'ipv6', 'uri', 'uri-reference', 'iri', 'iri-reference', 'uuid', 'uri-template', 'json-pointer', 'relative-json-pointer', 'regex']);
function walkSchema(node, tool, path = '') {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n, i) => walkSchema(n, tool, `${path}[${i}]`)); return; }
  if ('type' in node && Array.isArray(node.type)) issues.push(`[${tool}] type 为数组: ${JSON.stringify(node.type)} @${path}`);
  if ('format' in node && typeof node.format === 'string' && !KNOWN_FORMATS.has(node.format)) issues.push(`[${tool}] 非标准 format='${node.format}' @${path}`);
  if ('enum' in node) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) issues.push(`[${tool}] enum 非法 @${path}`);
    else if (node.enum.some((v) => typeof v === 'object' && v !== null)) issues.push(`[${tool}] enum 含对象 @${path}`);
  }
  if ('pattern' in node) { try { new RegExp(node.pattern); } catch { issues.push(`[${tool}] pattern 非法正则 @${path}`); } }
  if ('required' in node && Array.isArray(node.required) && node.properties && typeof node.properties === 'object') {
    for (const r of node.required) if (!(r in node.properties)) issues.push(`[${tool}] required 引用了不存在的属性 '${r}' @${path}`);
    if (node.required.length !== new Set(node.required).size) issues.push(`[${tool}] required 有重复项 @${path}`);
  }
  if ('additionalProperties' in node && typeof node.additionalProperties === 'object' && node.additionalProperties !== null) issues.push(`[${tool}] additionalProperties 为 schema(部分提供方只接受布尔) @${path}`);
  if ('default' in node && node.default !== null && typeof node.default === 'object') issues.push(`[${tool}] default 为对象 @${path}`);
  for (const [k, v] of Object.entries(node)) {
    if (['properties', 'patternProperties', '$defs', 'definitions'].includes(k) && v && typeof v === 'object') for (const [pk, pv] of Object.entries(v)) { if (/[^A-Za-z0-9_.\-]/.test(pk)) issues.push(`[${tool}] 属性名含特殊字符 '${pk}' @${path}`); walkSchema(pv, tool, `${path}.${k}.${pk}`); }
    else if (['items', 'additionalItems', 'not', 'contains'].includes(k)) walkSchema(v, tool, `${path}.${k}`);
    else if (['anyOf', 'oneOf', 'allOf', 'prefixItems'].includes(k) && Array.isArray(v)) v.forEach((n, i) => walkSchema(n, tool, `${path}.${k}[${i}]`));
  }
}
const tools = b.tools ?? [];
stats.tools = tools.length;
let schemaBytes = 0;
for (const t of tools) { const fn = t.function ?? t; schemaBytes += JSON.stringify(fn.parameters ?? {}).length; walkSchema(fn.parameters ?? {}, fn.name ?? '?'); }
stats.schemaBytes = schemaBytes;

/* ---------- 消息层 ---------- */
const ms = b.messages ?? [];
stats.messages = ms.length;
const declaredIds = new Set();
for (const m of ms) for (const tc of m.tool_calls ?? []) { if (tc.id) declaredIds.add(tc.id); }
let orphanToolMsgs = 0, badArgs = 0, noRole = 0, longRc = 0, maxRc = 0, inlinedImages = 0;
let contentTypes = new Set();
for (const m of ms) {
  if (!['system', 'user', 'assistant', 'tool'].includes(m.role)) noRole++;
  if (m.role === 'tool' && m.tool_call_id && !declaredIds.has(m.tool_call_id)) orphanToolMsgs++;
  if (Array.isArray(m.content)) for (const c of m.content) { contentTypes.add(c?.type); }
  for (const tc of m.tool_calls ?? []) {
    const a = tc.function?.arguments;
    if (typeof a === 'string') { try { JSON.parse(a); } catch { badArgs++; } }
    else if (a !== undefined) issues.push(`tool_call.arguments 不是字符串: ${typeof a}`);
  }
  if (typeof m.reasoning_content === 'string') { if (m.reasoning_content.length > maxRc) maxRc = m.reasoning_content.length; }
}
stats.contentPartTypes = [...contentTypes].join(',') || '(纯字符串)';
issues.push(...(noRole ? [`${noRole} 条消息角色异常`] : []));
issues.push(...(orphanToolMsgs ? [`${orphanToolMsgs} 条 tool 消息找不到对应 tool_call`] : []));
issues.push(...(badArgs ? [`${badArgs} 条 tool_call 的 arguments 不是合法 JSON`] : []));
if (maxRc) issues.push(`最长 reasoning_content = ${maxRc} 字符`);
stats.hasReasoningContent = ms.some((m) => typeof m.reasoning_content === 'string');
stats.hasReasoningEffort = 'reasoning_effort' in b;

/* ---------- 尺寸 ---------- */
stats.bodyBytes = JSON.stringify(b).length;
stats.messagesBytes = JSON.stringify(ms).length;
stats.maxMessageBytes = Math.max(...ms.map((m) => JSON.stringify(m).length));

console.log('== 规模 ==');
console.log(JSON.stringify(stats, null, 1));
console.log('\n== 可疑点 (' + issues.length + ') ==');
if (!issues.length) console.log('  (无结构性可疑点)');
else for (const s of issues.slice(0, 25)) console.log('  - ' + s);
