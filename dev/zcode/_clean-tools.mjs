// 定位携带非标准 schema 关键字的工具 + 演示递归清理(只删 schema 位置的非标准键,不动 properties 里的同名参数)
import fs from 'node:fs';
const f = process.argv[2];
const d = JSON.parse(fs.readFileSync(f, 'utf8'));
const b = d.body ?? d;

const BLACK = ['$schema', 'propertyNames', 'annotations', '$comment', 'nullable', 'x-'];
const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
const SCHEMA_CHILD_KEYS = new Set(['items', 'additionalProperties', 'additionalItems', 'not', 'if', 'then', 'else', 'contains', 'propertyNames']);
const SCHEMA_LIST_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

function hits(node, found = [], path = '') {
  if (node === null || typeof node !== 'object') return found;
  if (Array.isArray(node)) { node.forEach((n, i) => hits(n, found, `${path}[${i}]`)); return found; }
  for (const [k, v] of Object.entries(node)) {
    if (BLACK.some((x) => (x.endsWith('-') ? k.startsWith(x.slice(0, -1)) : k === x))) found.push(`${path}.${k}`);
    if (SCHEMA_MAP_KEYS.has(k) && v && typeof v === 'object') for (const [pk, pv] of Object.entries(v)) hits(pv, found, `${path}.${k}.${pk}`);
    else if (SCHEMA_CHILD_KEYS.has(k)) hits(v, found, `${path}.${k}`);
    else if (SCHEMA_LIST_KEYS.has(k) && Array.isArray(v)) v.forEach((n, i) => hits(n, found, `${path}.${k}[${i}]`));
  }
  return found;
}
console.log('=== 携带非标准键的工具 ===');
for (const t of b.tools ?? []) {
  const fn = t.function ?? t;
  const found = hits(fn.parameters, [], fn.name);
  if (found.length) console.log(`  ${fn.name}: ${found.slice(0, 6).join(', ')}${found.length > 6 ? ` …(+${found.length - 6})` : ''}`);
}

function clean(node) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) { node.forEach(clean); return node; }
  for (const k of Object.keys(node)) {
    if (BLACK.some((x) => (x.endsWith('-') ? k.startsWith(x.slice(0, -1)) : k === x))) { delete node[k]; continue; }
    if (SCHEMA_MAP_KEYS.has(k) && node[k] && typeof node[k] === 'object') { for (const pv of Object.values(node[k])) clean(pv); continue; }
    if (SCHEMA_CHILD_KEYS.has(k) || SCHEMA_LIST_KEYS.has(k)) clean(node[k]);
  }
  return node;
}
const before = JSON.stringify(b.tools).length;
for (const t of b.tools ?? []) clean((t.function ?? t).parameters);
const after = JSON.stringify(b.tools).length;
console.log('\n=== 清理结果 ===');
console.log(`  tools 体积: ${before} → ${after} 字符 (减少 ${before - after})`);
const left = [];
for (const t of b.tools ?? []) { const fn = t.function ?? t; const found = hits(fn.parameters, [], fn.name); if (found.length) left.push(`${fn.name}: ${found.join(',')}`); }
console.log('  残留非标准键:', left.length ? left.join(' | ') : '(无) ✓');
// 确认没有误删「同名参数」(properties 里叫 metadata/annotations 的属性应保留)
const probe = [];
for (const t of b.tools ?? []) { const fn = t.function ?? t; const props = fn.parameters?.properties ?? {}; for (const pn of ['metadata', 'annotations', 'propertyNames']) if (props[pn]) probe.push(`${fn.name}.${pn}`); }
console.log('  properties 中的同名参数(应保留):', probe.length ? probe.join(', ') : '(无)');
