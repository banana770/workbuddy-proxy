#!/usr/bin/env node
/**
 * WorkBuddy 反代看门狗
 * ====================
 * 每 60 秒巡检四个反代端口，谁没在监听就把它拉起来（detached，脱离本进程组）。
 * 依赖:none(Node 22 内置 fetch)。
 *
 * 端口表(与 workbuddy-proxy-autostart/README.md 一致):
 *   8400 zcode 国内版   cn
 *   8401 codex 国内版   cn
 *   8402 zcode 国际版   ai   (workbuddy.ai)
 *   8403 codex 国际版   ai
 *
 * 日志:默认写到本目录 watchdog.log，可用 WB_WATCHDOG_LOG 覆盖。
 * 用法:node proxy-watchdog.mjs [--once] [--interval 60000]
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = dirname(HERE); // dsh工作区2
const LOG = process.env.WB_WATCHDOG_LOG || join(HERE, 'watchdog.log');

const TARGETS = [
  { port: 8400, dir: join(BASE, 'zcode-workbuddy-proxy'), variant: 'cn' },
  { port: 8401, dir: join(BASE, 'codex-workbuddy-proxy'), variant: 'cn' },
  { port: 8402, dir: join(BASE, 'zcode-workbuddy-proxy'), variant: 'ai' },
  { port: 8403, dir: join(BASE, 'codex-workbuddy-proxy'), variant: 'ai' },
];

const argv = process.argv.slice(2);
const once = argv.includes('--once');
const interval = Number((argv.find((a) => a.startsWith('--interval=')) ?? '').slice(11)) || 60_000;

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG, line + '\n'); } catch {}
};

async function alive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

function start(target) {
  const env = { ...process.env };
  if (target.variant === 'ai') env.WB_VARIANT = 'ai'; else delete env.WB_VARIANT;
  const child = spawn(process.execPath, ['proxy.mjs'], {
    cwd: target.dir,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  log(`:${target.port} 未监听 → 已拉起(variant=${target.variant}, pid=${child.pid})`);
}

async function sweep() {
  for (const t of TARGETS) {
    if (!(await alive(t.port))) await start(t);
  }
}

await sweep();
log(`巡检完成(一次)。${once ? '' : `之后每 ${Math.round(interval / 1000)} 秒一轮。`}`);

if (!once) {
  setInterval(() => { sweep().catch((e) => log(`巡检异常: ${String(e).slice(0, 160)}`)); }, interval);
}
