#!/usr/bin/env node
/** 多帧遍历:统计会话事件类型与上下文相关数值(只输出计数,不输出内容) */
const fs = require('fs');
const { zstdDecompressSync } = require('node:zlib');
const ZSTD_MAGIC = 4247762216;

function frames(buf) {
  const out = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) break;
    const start = off; off += 4;
    const descriptor = buf.readUInt8(off); off += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dict = descriptor & 3;
    off += (dict === 3 ? 4 : dict) + (singleSegment ? 0 : 1) + (contentSizeFlag === 0 ? 0 : 1 << contentSizeFlag);
    for (;;) {
      if (buf.length - off < 3) return out;
      const bh = buf.readUIntLE(off, 3); off += 3;
      const last = (bh & 1) !== 0, type = (bh >>> 1) & 3, size = bh >>> 3;
      if (type === 3) return out;
      off += type === 1 ? 1 : size;
      if (last) break;
    }
    if (checksum) off += 4;
    out.push([start, off]);
  }
  return out;
}

const p = process.argv[2];
const buf = fs.readFileSync(p);
const fs2 = frames(buf);
let lines = 0;
const types = new Map();
const nums = [];
for (const [s, e] of fs2) {
  let plain;
  try { plain = zstdDecompressSync(buf.subarray(s, e)).toString('utf8'); } catch { continue; }
  for (const l of plain.split('\n')) {
    if (!l.trim()) continue;
    lines++;
    try {
      const o = JSON.parse(l);
      const t = typeof o.type === 'string' ? o.type : '(无type)';
      types.set(t, (types.get(t) ?? 0) + 1);
      (function w(o) {
        if (o && typeof o === 'object') {
          for (const [k, v] of Object.entries(o)) {
            if (/context|window/i.test(k) && typeof v === 'number') nums.push(`${k}=${v}`);
            if (typeof v === 'object' && v !== null) w(v);
          }
        }
      })(o);
    } catch {}
  }
}
console.log(`帧数: ${fs2.length} | 行数: ${lines}`);
console.log('事件类型 Top10:', [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, c]) => `${t}×${c}`).join(', '));
const uniq = [...new Set(nums)].slice(0, 10);
console.log('上下文数值字段:', uniq.length ? uniq.join(', ') : '(无)');
const comp = [...types.entries()].filter(([t]) => /compact/i.test(t));
console.log('压缩类事件:', comp.length ? comp.map(([t, c]) => `${t}×${c}`).join(', ') : '无');
