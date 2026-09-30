// 内容层体检:控制字符、非法代理对、超长字段、可疑 base64——这类内容最容易被上游参数校验拒绝
import fs from 'node:fs';
const files = process.argv.slice(2);
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const b = d.body ?? d;
  console.log('━━━', f.split(/[\\/]/).pop(), '| at', d.at, '| 消息', (b.messages ?? []).length);
  const ctrl = [];
  const surro = [];
  let maxStr = 0, maxMsg = 0, b64ish = 0;
  const CT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
  const walk = (v, path) => {
    if (typeof v === 'string') {
      const m = v.match(CT);
      if (m) ctrl.push(`${path} → ${m.length} 个控制字符(样例 U+${m[0].charCodeAt(0).toString(16).padStart(4, '0')})`);
      if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v)) surro.push(path);
      if (v.length > maxStr) maxStr = v.length;
      if (v.length > 4000 && /^[A-Za-z0-9+/=\s]+$/.test(v.slice(0, 2000))) b64ish += 1;
      return;
    }
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    for (const [k, val] of Object.entries(v)) walk(val, path ? `${path}.${k}` : k);
  };
  b.messages.forEach((m, i) => {
    const s = JSON.stringify(m).length;
    if (s > maxMsg) maxMsg = s;
    walk(m, `msg[${i}:${m.role}]`);
  });
  console.log('  单条消息最大:', maxMsg, 'B | 最长字符串:', maxStr, '| 疑似 base64 大串:', b64ish);
  console.log('  控制字符:', ctrl.length ? ctrl.slice(0, 6).join(' ;; ') : '(无)');
  console.log('  非法代理对:', surro.length ? surro.slice(0, 4).join(', ') : '(无)');
  // tool 结果长度排行
  const tl = b.messages.filter((m) => m.role === 'tool').map((m, i) => ({ i, len: typeof m.content === 'string' ? m.content.length : -1 })).sort((a, z) => z.len - a.len).slice(0, 3);
  console.log('  最长的 tool 结果(前3):', tl.map((x) => x.len + 'B').join(', ') || '(无)');
  console.log('');
}
