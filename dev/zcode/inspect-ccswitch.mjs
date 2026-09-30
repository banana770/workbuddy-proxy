// Inspect cc-switch SQLite DB: schema + provider rows (read-only).
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("C:/Users/<USER>/.cc-switch/cc-switch.db", { readOnly: true });
const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all();
for (const t of tables) {
  console.log("=== TABLE " + t.name + " ===");
  console.log(t.sql);
  try {
    const n = db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get();
    console.log("rows:", n.c);
  } catch (e) {
    console.log("count failed:", String(e));
  }
  console.log();
}
