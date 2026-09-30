// Inspect captured messages + sub-bisect which message triggers 11128.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const authPath = join(process.env.LOCALAPPDATA, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info");
const doc = JSON.parse(await readFile(authPath, "utf8"));
const auth = doc.auth ?? doc;
const uid = doc.account?.uid ?? "";
const domain = auth.domain ?? "";
const base = "https://copilot.tencent.com";
const headers = {
  Accept: "application/json, text/plain, */*",
  "X-Requested-With": "XMLHttpRequest",
  Origin: "https://www.codebuddy.cn",
  Referer: "https://www.codebuddy.cn/",
  "User-Agent": "CLI/2.63.2 CodeBuddy/2.63.2",
  "Content-Type": "application/json",
  ...(uid ? { "X-User-Id": uid } : { "X-No-User-Id": "1" }),
  ...(domain ? { "X-Domain": domain } : { "X-No-Department-Info": "1" }),
  "X-Product": "SaaS",
  Authorization: `Bearer ${auth.accessToken}`,
};

const captured = JSON.parse(await readFile("D:/dsh工作区/dsh工作区2/codex-workbuddy-proxy/proxy-debug-body.json", "utf8"));

console.log("=== captured messages ===");
captured.messages.forEach((m, i) => {
  const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  console.log(`[${i}] role=${m.role} len=${c.length}`);
  console.log("    head:", JSON.stringify(c.slice(0, 220)));
  console.log("    tail:", JSON.stringify(c.slice(-160)));
});

const clone = (b) => JSON.parse(JSON.stringify(b));
async function probe(label, body) {
  const res = await fetch(`${base}/v2/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
  if (res.ok) { await res.text(); console.log(`${label.padEnd(46)} OK`); return true; }
  const text = await res.text();
  let info = `HTTP ${res.status}`;
  try { const j = JSON.parse(text); info += ` code=${j.code}`; } catch {}
  console.log(`${label.padEnd(46)} ${info}`);
  return false;
}

// Keep only system[0] + user[i], one at a time
for (let i = 1; i < captured.messages.length; i++) {
  const b = clone(captured);
  b.messages = [captured.messages[0], captured.messages[i]];
  delete b.tools; delete b.tool_choice;
  await probe(`system[0] + messages[${i}](${captured.messages[i].role})`, b);
}

// system[0] alone + trivial user
{
  const b = clone(captured);
  b.messages = [captured.messages[0], { role: "user", content: "只回复:OK" }];
  delete b.tools; delete b.tool_choice;
  await probe("system[0](full) + trivial user", b);
}

// trivial system + each user message
for (let i = 1; i < captured.messages.length; i++) {
  const b = clone(captured);
  b.messages = [{ role: "system", content: "你是简洁助手。" }, captured.messages[i]];
  delete b.tools; delete b.tool_choice;
  await probe(`trivial system + messages[${i}](${captured.messages[i].role})`, b);
}
console.log("\nSUB-BISECT DONE");
