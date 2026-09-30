#!/usr/bin/env node
/**
 * session-meta-probe.js —— 只读会话日志的【结构与元数据】,绝不输出消息内容。
 * 安全设计:任何长度 > 40 的字符串一律打码;只打印 键名 / 数字 / 布尔 / 短字符串。
 * 目的:确认旧会话是否快照了模型的 contextWindow(300k)。
 */
const fs = require('fs');
const path = require('path');
const { zstdDecompressSync } = require('node:zlib');

const SESSIONS = 'C:/Users/<USER>/.dsh/sessions';
const MASK = (v) => (typeof v === 'string' ? (v.length <= 40 ? v : `<str:${v.length}>`) : v);
function safe(o, depth = 0) {
  if (depth > 4) return '…';
  if (o === null || typeof o !== 'object') return MASK(o);
  if (Array.isArray(o)) return o.slice(0, 3).map((x) => safe(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = safe(v, depth + 1);
  return out;
}
function interesting(o, hits, where) {
  if (o === null || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (/context|window|truncate|compact/i.test(k) && (typeof v === 'number' || typeof v === 'boolean')) {
      hits.push(`${where}: ${k} = ${v}`);
    }
    if (typeof v === 'object' && v !== null) interesting(v, hits, where);
  }
}

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === 'session.jsonl.zstd') files.push({ p, mtime: fs.statSync(p).mtimeMs });
  }
})(SESSIONS);
files.sort((a, b) => b.mtime - a.mtime);
console.log('会话文件总数:', files.length, '| 探查最近', Math.min(4, files.length), '个\n');

for (const { p, mtime } of files.slice(0, 4)) {
  console.log('━━ ' + p.replace(SESSIONS, '…sessions') + '  (mtime ' + new Date(mtime).toLocaleTimeString('zh-CN') + ')');
  try {
    const buf = fs.readFileSync(p);
    const plain = zstdDecompressSync(buf).toString('utf8');
    const lines = plain.split('\n').filter((l) => l.trim());
    console.log('  行数:', lines.length);
    const hits = [];
    lines.forEach((l, i) => {
      try {
        const o = JSON.parse(l);
        if (i === 0) console.log('  首行(头)键:', Object.keys(o).join(', '));
        interesting(o, hits, `L${i}`);
      } catch {}
    });
    const uniq = [...new Set(hits)].slice(0, 12);
    console.log(uniq.length ? '  上下文相关元数据:\n    ' + uniq.join('\n    ') : '  (未发现 contextWindow 类字段)');
  } catch (e) {
    console.log('  读取失败:', String(e).slice(0, 80));
  }
  console.log('');
}
