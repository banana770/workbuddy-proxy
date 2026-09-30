// 核验 cc-switch 里 WorkBuddy provider 的模型目录
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('C:/Users/<USER>/.cc-switch/cc-switch.db', { readOnly: true });
const r = db.prepare(`SELECT settings_config FROM providers WHERE id='codex-workbuddy-proxy' AND app_type='codex'`).get();
const c = JSON.parse(r.settings_config);
const ids = c.modelCatalog.models.map((m) => m.model);

console.log('catalog 模型数:', ids.length);
console.log('含 deepseek-v4.1-flash   :', ids.includes('deepseek-v4.1-flash'));
console.log('含 deepseek-v4-flash(应否):', ids.includes('deepseek-v4-flash'));
console.log('');
console.log('默认 model :', /^model\s*=\s*"(.+?)"/mu.exec(c.config)?.[1]);
console.log('base_url   :', /^base_url\s*=\s*"(.+?)"/mu.exec(c.config)?.[1]);
console.log('wire_api   :', /^wire_api\s*=\s*"(.+?)"/mu.exec(c.config)?.[1]);
console.log('');
console.log('catalog 明细:');
for (const m of c.modelCatalog.models) {
	console.log('  ' + m.model.padEnd(22) + ' | ' + String(m.displayName).padEnd(24) + ' | ctx=' + m.contextWindow);
}
