// 给 zcode 配置增加「WorkBuddy AI」(国际版, 8402) provider —— 带备份,幂等
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const CFG = 'C:/Users/<USER>/.zcode/v2/config.json';
const CAT = 'C:/Users/<USER>/.dsh/.workbuddy-ai-catalog.json';
const PID = 'zcode-workbuddy-ai-proxy';

const cfg = JSON.parse(readFileSync(CFG, 'utf8'));
const cat = JSON.parse(readFileSync(CAT, 'utf8'));
const entry = Object.values(cat.entries ?? {})[0];
if (!entry?.models?.length) { console.error('❌ 目录为空'); process.exit(1); }

const models = {};
for (const m of entry.models) {
  const r = m.reasoning ?? {};
  const reasoning = { enabled: r.supports === true };
  if (r.supports === true) {
    let variants;
    if (Array.isArray(r.supportedEfforts) && r.supportedEfforts.length) variants = r.supportedEfforts;
    else if (typeof r.defaultEffort === 'string') variants = [r.defaultEffort];
    else variants = ['medium'];
    if (r.canDisableThinking === true) variants = ['off', ...variants];
    reasoning.variants = variants;
    reasoning.defaultVariant = typeof r.defaultEffort === 'string' ? r.defaultEffort : variants[variants.length - 1];
  }
  models[m.id] = {
    name: m.name ?? m.id,
    reasoning,
    limit: { context: Number(m.contextWindow) || 200000, output: Number(m.maxTokens) || 32000 },
    modalities: { input: ['text'], output: ['text'] },
    zcode: { modified: false, priority: 50 },
  };
}

const provider = {
  name: 'WorkBuddy AI',
  kind: 'anthropic',
  enabled: true,
  source: 'custom',
  options: { apiKey: 'zcode-workbuddy-ai', baseURL: 'http://127.0.0.1:8402', apiKeyRequired: true },
  models,
};

const existed = Boolean(cfg.provider?.[PID]);
if (!existed && existsSync(CFG)) copyFileSync(CFG, CFG + '.bak-wbai-20260913');
cfg.provider = cfg.provider ?? {};
cfg.provider[PID] = provider;
writeFileSync(CFG, JSON.stringify(cfg, null, 2));
console.log(`${existed ? '更新' : '新增'} provider ${PID}: ${Object.keys(models).length} 个模型`);
console.log('模型:', Object.keys(models).join(', '));
if (!existed) console.log('备份:', CFG + '.bak-wbai-20260913');
