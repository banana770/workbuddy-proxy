// 只读转储 cc-switch 里 codex 类型的 provider 配置（用于照抄结构）
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('C:/Users/<USER>/.cc-switch/cc-switch.db', { readOnly: true });
const rows = db
	.prepare(`SELECT id, name, is_current, category, sort_index, settings_config, meta, website_url, provider_type
	          FROM providers WHERE app_type = 'codex' ORDER BY sort_index`)
	.all();

for (const r of rows) {
	console.log('==============================================');
	console.log(`id=${r.id}  name=${r.name}  current=${r.is_current}  sort=${r.sort_index}  cat=${r.category}  ptype=${r.provider_type}`);
	try {
		console.log('settings_config: ' + JSON.stringify(JSON.parse(r.settings_config), null, 2));
	} catch {
		console.log('settings_config(raw): ' + String(r.settings_config).slice(0, 800));
	}
	if (r.meta && r.meta !== '{}') console.log('meta: ' + r.meta);
	if (r.website_url) console.log('website_url: ' + r.website_url);
}

console.log('\n=== providers 表结构 ===');
const t = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='providers'`).get();
console.log(t?.sql ?? '(not found)');
