// 修复：把我写入的 sort_index=-1 改成 NULL（其它 provider 用的就是这个值）
// cc-switch 是 Rust 实现，sort_index 按无符号整数读取，-1 会触发
// "Integer -1 out of range at index 6"，导致读取 provider 列表失败、应用打不开。
import { DatabaseSync } from 'node:sqlite';

const DB = 'C:/Users/<USER>/.cc-switch/cc-switch.db';
const db = new DatabaseSync(DB);

console.log('=== 修复前：负的 sort_index ===');
const bad = db.prepare(`SELECT id, app_type, name, sort_index FROM providers WHERE sort_index < 0`).all();
for (const r of bad) console.log(`  ${r.app_type} | ${r.id} | ${r.name} | sort_index=${r.sort_index}`);
if (bad.length === 0) console.log('  (无)');

const res = db.prepare(`UPDATE providers SET sort_index = NULL WHERE sort_index < 0`).run();
console.log(`\n[fix] 已把 ${res.changes} 行的 sort_index 置为 NULL`);

console.log('\n=== 修复后：全部 codex provider ===');
for (const r of db.prepare(`SELECT id, name, is_current, sort_index FROM providers WHERE app_type='codex' ORDER BY sort_index`).all()) {
	console.log(`  ${r.is_current ? '*' : ' '} ${r.name.padEnd(18)} sort_index=${r.sort_index === null ? 'NULL' : r.sort_index}`);
}

console.log('\n=== 全库再查一遍负值 ===');
const still = db.prepare(`SELECT COUNT(*) AS c FROM providers WHERE sort_index < 0`).get();
console.log(`  负值行数: ${still.c}`);

console.log('\n=== integrity_check ===');
console.log('  ' + db.prepare('PRAGMA integrity_check').get().integrity_check);
