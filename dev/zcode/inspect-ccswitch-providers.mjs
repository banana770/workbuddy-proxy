// Dump cc-switch providers for codex (schema + settings_config shapes).
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("C:/Users/<USER>/.cc-switch/cc-switch.db", { readOnly: true });
const rows = db.prepare("SELECT id, app_type, name, settings_config, website_url, category, sort_index, meta, is_current, provider_type FROM providers ORDER BY app_type, sort_index").all();
for (const r of rows) {
  console.log("──────────────────────────────────────────────");
  console.log(`app_type=${r.app_type} id=${r.id} name=${r.name} current=${r.is_current} sort=${r.sort_index} cat=${r.category} ptype=${r.provider_type}`);
  try {
    const cfg = JSON.parse(r.settings_config);
    console.log("settings_config:", JSON.stringify(cfg, null, 2));
  } catch {
    console.log("settings_config(raw):", String(r.settings_config).slice(0, 500));
  }
  if (r.meta && r.meta !== "{}") console.log("meta:", r.meta);
}
