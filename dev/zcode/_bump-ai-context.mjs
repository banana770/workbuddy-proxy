#!/usr/bin/env node
/**
 * 把 WorkBuddy AI(国际版)目录里被低估的上下文拉到与国内版同款模型的最大值。
 * 现状:deepseek-v4.1-flash 与 hy4-preview-f 被报 300k,国内版同款为 1M。
 * 同时同步:~/.zcode/v2/config.json 里 zcode-workbuddy-ai-proxy 的 limit.context。
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const AI_CAT = 'C:/Users/<USER>/.dsh/.workbuddy-ai-catalog.json';
const CN_CAT = 'C:/Users/<USER>/.dsh/.workbuddy-catalog.json';
const ZCFG = 'C:/Users/<USER>/.zcode/v2/config.json';
const ZPID = 'zcode-workbuddy-ai-proxy';
const ALIAS = { 'hy4-preview-f': 'hy4-preview' };

const modelsOf = (file) => {
  const d = JSON.parse(readFileSync(file, 'utf8'));
  const e = Object.values(d.entries ?? {})[0];
  return [d, Object.fromEntries((e?.models ?? []).map((m) => [m.id, m]))];
};

const [, cnMap] = modelsOf(CN_CAT);
const [aiDoc, aiMap] = modelsOf(AI_CAT);
copyFileSync(AI_CAT, AI_CAT + '.bak-ctx-20260913');

const bumped = [];
for (const [id, m] of Object.entries(aiMap)) {
  const base = ALIAS[id] ?? id;
  const cn = cnMap[base] ?? cnMap[id];
  if (!cn) continue;
  const cnMax = Math.max(Number(cn.contextWindow) || 0, Number(cn.maxInputTokens) || 0);
  if (cnMax > (Number(m.contextWindow) || 0)) {
    m.contextWindow = cnMax;
    if (Number(m.maxInputTokens) || 0) m.maxInputTokens = cnMax;
    bumped.push(`${id}: ${m.contextWindow === cnMax ? '' : '(旧值)'}→ ${cnMax}`);
    bumped[bumped.length - 1] = `${id}: → ${cnMax}`;
  }
}
writeFileSync(AI_CAT, JSON.stringify(aiDoc, null, 2));
console.log('目录已更新:', bumped.length ? bumped.join(' | ') : '(无需改动)');

/* --- 同步 zcode 配置的 limit.context --- */
const zc = JSON.parse(readFileSync(ZCFG, 'utf8'));
const prov = zc.provider?.[ZPID];
if (!prov) { console.log('zcode 配置里没有', ZPID); process.exit(0); }
const zFixed = [];
for (const [id, mm] of Object.entries(prov.models ?? {})) {
  const ai = aiMap[id];
  if (!ai) continue;
  const want = Number(ai.contextWindow) || 0;
  const cur = Number(mm.limit?.context) || 0;
  if (want && want !== cur) { zFixed.push(`${id}: ${cur} → ${want}`); mm.limit.context = want; }
}
if (zFixed.length) {
  copyFileSync(ZCFG, ZCFG + '.bak-ctx-20260913');
  writeFileSync(ZCFG, JSON.stringify(zc, null, 2));
}
console.log('zcode limit.context:', zFixed.length ? zFixed.join(' | ') : '(已是最新)');
