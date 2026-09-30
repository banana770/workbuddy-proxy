// 查 ZCode 当前配置里各 provider 的启用/选中状态
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const F = path.join(os.homedir(), '.zcode', 'v2', 'config.json');
const cfg = JSON.parse(fs.readFileSync(F, 'utf8'));
const table = cfg.provider ?? {};

console.log('=== ZCode providers ===');
for (const [id, p] of Object.entries(table)) {
	const models = p.models ? Object.keys(p.models) : [];
	console.log(`  ${id}`);
	console.log(`      name=${p.name}  kind=${p.kind}  enabled=${p.enabled}  source=${p.source}`);
	console.log(`      baseURL=${p.options?.baseURL ?? '-'}`);
	console.log(`      models=${models.length}${models.length && models.length <= 8 ? '  [' + models.join(', ') + ']' : ''}`);
	if (p.systemDisabledReason) console.log(`      systemDisabledReason=${p.systemDisabledReason}`);
}

console.log('\n=== 顶层其它键 ===');
for (const k of Object.keys(cfg)) if (k !== 'provider') console.log(`  ${k}: ${JSON.stringify(cfg[k]).slice(0, 200)}`);

// 找“当前选中”的痕迹
console.log('\n=== 搜索 current/selected/default/active 痕迹 ===');
const s = JSON.stringify(cfg);
for (const kw of ['current', 'selected', 'activeProvider', 'defaultProvider', 'lastUsed']) {
	const i = s.indexOf(kw);
	if (i >= 0) console.log(`  含 "${kw}": ...${s.slice(Math.max(0, i - 60), i + 120)}...`);
}
