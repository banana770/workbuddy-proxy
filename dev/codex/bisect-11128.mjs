// Bisect the 11128 trigger: replay captured body variants straight to the upstream.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const authPath = join(process.env.LOCALAPPDATA, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info");
const doc = JSON.parse(await readFile(authPath, "utf8"));
const auth = doc.auth ?? doc;
const uid = doc.account?.uid ?? "";
const domain = auth.domain ?? "";
const base = "https://copilot.tencent.com";

const headers = {
  "Accept": "application/json, text/plain, */*",
  "X-Requested-With": "XMLHttpRequest",
  "Origin": "https://www.codebuddy.cn",
  "Referer": "https://www.codebuddy.cn/",
  "User-Agent": "CLI/2.63.2 CodeBuddy/2.63.2",
  "Content-Type": "application/json",
  ...(uid ? { "X-User-Id": uid } : { "X-No-User-Id": "1" }),
  ...(domain ? { "X-Domain": domain } : { "X-No-Department-Info": "1" }),
  "X-Product": "SaaS",
  Authorization: `Bearer ${auth.accessToken}`,
};

const captured = JSON.parse(await readFile("D:/dsh工作区/dsh工作区2/codex-workbuddy-proxy/proxy-debug-body.json", "utf8"));

async function probe(label, body) {
  const res = await fetch(`${base}/v2/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
  let summary = "";
  if (res.ok) {
    const text = await res.text();
    summary = `OK (${text.length} bytes sse)`;
  } else {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      summary = `HTTP ${res.status} code=${j.code} msg=${String(j.msg).slice(0, 60)}`;
    } catch {
      summary = `HTTP ${res.status} ${text.slice(0, 80)}`;
    }
  }
  console.log(`${label.padEnd(34)} ${summary}`);
  return res.ok;
}

const clone = (b) => JSON.parse(JSON.stringify(b));
const base_ = clone(captured);

// A: as-is
await probe("A as-is", base_);
// B: truncate first system prompt
const b = clone(base_);
b.messages[0].content = b.messages[0].content.slice(0, 200) + "...";
await probe("B short system(200)", b);
// C: drop tools
const c = clone(base_);
delete c.tools; delete c.tool_choice;
await probe("C no tools", c);
// D: drop 2nd system message
const d = clone(base_);
d.messages = d.messages.filter((m, i) => !(i === 1 && m.role === "system"));
await probe("D single system", d);
// E: short system + user only
const e = clone(base_);
e.messages = [
  { role: "system", content: "你是简洁助手。" },
  { role: "user", content: "只回复:OK" },
];
delete e.tools; delete e.tool_choice; delete e.reasoning_effort;
await probe("E minimal", e);
// F: as-is but free model
const f = clone(base_);
f.model = "hy4-preview";
await probe("F hy4-preview + full prompt", f);
// G: as-is without reasoning_effort
const g = clone(base_);
delete g.reasoning_effort;
await probe("G no effort", g);
// H: as-is without tool_choice
const h = clone(base_);
delete h.tool_choice;
await probe("H no tool_choice", h);
// I: as-is, tools but no exec_command
const i2 = clone(base_);
i2.tools = i2.tools.filter((t) => t.function.name !== "exec_command");
await probe("I minus exec_command tool", i2);
// J: truncate system to 3000 chars
const j = clone(base_);
j.messages[0].content = j.messages[0].content.slice(0, 3000);
await probe("J system 3000 chars", j);
console.log("\nBISECT DONE");
