// WorkBuddy AI 通道一键检测
// 改为「打本地反代」的方式检测:反代自己负责凭据与上游,结果最贴近实际使用
// 结果写到同目录 ai-channel-status.txt(UTF-16,供 VBS 弹窗读取)
import { writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const lines = [];
lines.push(`检测时间:${new Date().toLocaleString('zh-CN', { hour12: false })}`);

function probePort(port) {
  return new Promise((resolve) => {
    const s = createConnection(port, '127.0.0.1');
    s.setTimeout(2000);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}

async function askProxy(port, path = '/v1/messages') {
  const t0 = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-check' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', max_tokens: 8, messages: [{ role: 'user', content: 'say ok' }] }),
      signal: AbortSignal.timeout(90000),
    });
    const text = (await r.text()).slice(0, 500);
    return { status: r.status, ok: r.ok, text, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, ok: false, text: String(e).slice(0, 200), ms: Date.now() - t0 };
  }
}

const up8402 = await probePort(8402);
const up8403 = await probePort(8403);
const up8400 = await probePort(8400);
lines.push(`本地 ZCode 反代(8402):${up8402 ? '✅ 运行中' : '❌ 未启动'}`);
lines.push(`本地 Codex 反代(8403):${up8403 ? '✅ 运行中' : '❌ 未启动'}`);

if (!up8402 && !up8403) {
  lines.push('→ 双击 workbuddy-proxy-autostart 里的 start-*-proxy-ai.vbs 可启动,或注销重登');
} else {
  const port = up8402 ? 8402 : 8403;
  const res = await askProxy(port);
  if (res.ok && (res.text.includes('"content"') || res.text.includes('chat.completion.chunk'))) {
    lines.push(`链路状态:✅ 正常(小请求耗时 ${(res.ms / 1000).toFixed(1)}s)`);
  } else if (res.status === 502 || res.status === 504) {
    lines.push(`链路状态:❌ 官方侧故障(HTTP ${res.status})——本地没问题,等官方恢复(App 不受影响)`);
  } else if (res.status === 401) {
    lines.push('链路状态:⚠️ 凭据失效——请在 WorkBuddy AI App 里重新登录');
  } else if (res.status === 0 || /fetch failed/i.test(res.text)) {
    lines.push(`链路状态:⚠️ 连接层瞬时失败(${(res.ms / 1000).toFixed(1)}s 内)——重发一次通常即通`);
    lines.push('说明:多为网络边缘抖动,与本地反代无关;国内版通常不受影响');
  } else if (res.text.includes('14018') || /credit/i.test(res.text)) {
    lines.push('链路状态:⚠️ 积分不足——充值或改用免费模型');
  } else {
    const brief = res.text.replace(/\s+/g, ' ').slice(0, 160);
    lines.push(`链路状态:⚠️ 异常响应(HTTP ${res.status},${(res.ms / 1000).toFixed(1)}s)`);
    lines.push(`详情:${brief}`);
  }

  // 国内版对照延迟(决定日常该走哪边)
  if (up8400) {
    const cn = await askProxy(8400);
    if (cn.ok) lines.push(`国内版对照(8400):✅ ${(cn.ms / 1000).toFixed(1)}s${res.ok && res.ms > cn.ms * 2 ? ' ← 明显更快,日常建议走这边' : ''}`);
  }
}

const report = lines.join('\n');
writeFileSync(join(HERE, 'ai-channel-status.txt'), '\uFEFF' + report, 'utf16le');
console.log(report);
