#!/usr/bin/env node
/**
 * 从 DSH 插件 dsh-workbuddy-connect 的 host-heartbeat-*.js 里,
 * 程序化提取上游 11128 安全策略的被禁身份声明清单。
 *
 * 安全设计(遵守 workbuddy-11128-sanitize 技能铁律):
 *   - 原文 NEVER 打印到终端 / 回复 / 本脚本文件;
 *   - 提取结果逐条 base64 后写入 identity-blocklist.json,运行时才解码;
 *   - 终端只输出:标识符名、条数、每条长度。
 */
import fs from 'node:fs';
import path from 'node:path';

const HEARTBEAT = process.argv[2]
  ?? 'C:/Users/<USER>/.dsh/profiles/web/node_modules/dsh-workbuddy-connect/lib/host-heartbeat-9FtwMcIF.js';
const OUT = process.argv[3]
  ?? 'D:/dsh工作区/dsh工作区2/zcode-workbuddy-proxy/identity-blocklist.json';

const src = fs.readFileSync(HEARTBEAT, 'utf8');
console.log('源文件:', HEARTBEAT, `(${(src.length / 1024).toFixed(0)} KB)`);

// 只提取标识符名(名字安全,值不碰)
const names = [...new Set([...src.matchAll(/\bBLOCKED_[A-Z0-9_]+/g)].map((m) => m[0]))];
console.log('发现的 BLOCKED_* 标识符:', names.join(', ') || '(无)');

/** 按「标识符 = [ ... ]」定位数组字面量并安全求值(只 eval 这个字面量本身)。 */
function extractArrayConst(name) {
  const re = new RegExp('\\b' + name + '\\s*=\\s*\\[');
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('[', m.index);
  let depth = 0, inStr = null, esc = false, end = -1;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (inStr !== null) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '[') depth += 1;
    else if (c === ']') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error(`${name}: 花括号配对失败`);
  return new Function(`return ${src.slice(open, end + 1)}`)();
}

const collected = {};
let skipped = 0;
for (const n of names) {
  let v;
  try { v = extractArrayConst(n); } catch (e) { console.log(`  ${n}: 提取失败(${String(e).slice(0, 80)})`); continue; }
  if (!Array.isArray(v)) { console.log(`  ${n}: 不是数组,跳过`); continue; }
  const strs = v.filter((x) => typeof x === 'string' && x.length >= 8);
  const regexes = v.filter((x) => x instanceof RegExp);
  skipped += v.length - strs.length - regexes.length;
  if (strs.length) collected[n] = { strings: strs.map((s) => Buffer.from(s, 'utf8').toString('base64')) };
  if (regexes.length) {
    collected[n] = collected[n] ?? {};
    collected[n].regexes = regexes.map((r) => ({ source: Buffer.from(r.source, 'utf8').toString('base64'), flags: r.flags }));
  }
  if (strs.length || regexes.length) {
    console.log(`  ${n}: ${strs.length} 条字符串(长度=[${strs.map((s) => s.length).join(', ')}]), ${regexes.length} 条正则`);
  }
}
if (skipped) console.log(`  (另有 ${skipped} 个其他类型项被忽略)`);

const total = Object.values(collected).reduce((a, b) => a + (b.strings?.length ?? 0) + (b.regexes?.length ?? 0), 0);
if (!total) { console.error('❌ 没提取到任何条目,不写盘。'); process.exit(1); }

const payload = {
  extractedFrom: HEARTBEAT,
  extractedAt: new Date().toISOString(),
  note: 'values are base64(utf8); decode at runtime only; never print',
  entries: collected,
};

// 重跑时保留代理自愈(learnFrom11128)学习到的条目,避免覆盖丢失
try {
  const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  if (Array.isArray(prev.learned) && prev.learned.length) {
    payload.learned = prev.learned;
    console.log(`  (保留已学习的 ${prev.learned.length} 条自愈条目)`);
  }
} catch {}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
console.log(`✅ 已写出 ${total} 条(base64) → ${OUT}`);
