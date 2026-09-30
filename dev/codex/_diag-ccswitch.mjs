// cc-switch 故障诊断（只读）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const DB = 'C:/Users/<USER>/.cc-switch/cc-switch.db';
console.log('=== 文件 ===');
for (const f of ['cc-switch.db', 'cc-switch.db-wal', 'cc-switch.db-shm', 'cc-switch.db-journal']) {
	const p = 'C:/Users/<USER>/.cc-switch/' + f;
	console.log(`  ${f}: ${fs.existsSync(p) ? fs.statSync(p).size + ' bytes' : '(不存在)'}`);
}

const db = new DatabaseSync(DB, { readOnly: true });

console.log('\n=== integrity_check ===');
console.log(db.prepare('PRAGMA integrity_check').all());

console.log('\n=== 我插入的行（全字段） ===');
const mine = db.prepare(`SELECT * FROM providers WHERE id='codex-workbuddy-proxy'`).all();
for (const r of mine) {
	for (const [k, v] of Object.entries(r)) {
		const s = typeof v === 'string' && v.length > 90 ? v.slice(0, 90) + `…(${v.length})` : v;
		console.log(`  ${k} = ${JSON.stringify(s)}`);
	}
}

console.log('\n=== 对比：一个正常的 codex 行（全字段） ===');
const other = db.prepare(`SELECT * FROM providers WHERE app_type='codex' AND id != 'codex-workbuddy-proxy' LIMIT 1`).all();
for (const r of other) {
	for (const [k, v] of Object.entries(r)) {
		const s = typeof v === 'string' && v.length > 90 ? v.slice(0, 90) + `…(${v.length})` : v;
		console.log(`  ${k} = ${JSON.stringify(s)}`);
	}
}

console.log('\n=== 所有行的关键字段 ===');
for (const r of db.prepare(`SELECT id, app_type, name, is_current, sort_index, category, provider_type, in_failover_queue, cost_multiplier, created_at FROM providers ORDER BY app_type, sort_index`).all()) {
	console.log('  ' + [r.app_type, r.id, r.name, 'cur=' + r.is_current, 'sort=' + r.sort_index, 'cat=' + r.category, 'ptype=' + r.provider_type, 'fo=' + r.in_failover_queue, 'cm=' + r.cost_multiplier, 'created=' + r.created_at].join(' | '));
}

console.log('\n=== 其它表 ===');
for (const t of db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()) {
	try {
		const c = db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get();
		console.log(`  ${t.name}: ${c.c} 行`);
	} catch (e) {
		console.log(`  ${t.name}: 统计失败 ${e.message}`);
	}
}
