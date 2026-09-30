// Bisect 5: minimal necessary sanitization scope.
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
const sys0 = captured.messages[0].content;
const sys1 = captured.messages[1].content;

async function probe(label, messages, extra = {}) {
  const body = { model: "glm-5.3-flash", stream: true, messages, ...extra };
  const res = await fetch(`${base}/v2/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
  if (res.ok) { await res.text(); console.log(`${label.padEnd(58)} OK`); return true; }
  const text = await res.text();
  let info = `HTTP ${res.status}`;
  try { const j = JSON.parse(text); info += ` code=${j.code}`; } catch {}
  console.log(`${label.padEnd(58)} ${info}`);
  return false;
}

const head = sys0.slice(0, 200);
console.log("HEAD:", JSON.stringify(head));
console.log();

// micro-bisect on the exact head (short prompt)
await probe("head200 as-is (short prompt)", [{ role: "system", content: head }, { role: "user", content: "只回复:OK" }]);
await probe("head200, only OpenAI renamed", [{ role: "system", content: head.replace(/OpenAI/g, "the vendor") }, { role: "user", content: "只回复:OK" }]);
await probe("head200, only Codex CLI renamed", [{ role: "system", content: head.replace(/Codex CLI/g, "the assistant") }, { role: "user", content: "只回复:OK" }]);
await probe("head200, Codex+OpenAI renamed", [{ role: "system", content: head.replace(/Codex CLI/g, "the assistant").replace(/Codex/g, "the assistant").replace(/OpenAI/g, "the vendor") }, { role: "user", content: "只回复:OK" }]);

// does the full 21k prompt fail even when only identity words in the FIRST 200 chars are renamed?
const onlyHeadRenamed = sys0.slice(0, 200).replace(/Codex CLI/g, "the assistant").replace(/Codex/g, "the assistant").replace(/OpenAI/g, "the vendor") + sys0.slice(200);
await probe("full sys0, identity renamed only in head200", [{ role: "system", content: onlyHeadRenamed }, { role: "user", content: "只回复:OK" }]);

// full request: sanitize ONLY system messages, leave user messages raw
const sanitize = (s) => s.replace(/Codex CLI/gi, "the coding assistant").replace(/Codex/gi, "the assistant").replace(/OpenAI/gi, "the vendor");
await probe("FULL body: sanitize system only, users raw",
  [{ role: "system", content: sanitize(sys0) + "\n\n" + sanitize(sys1) }, captured.messages[2], captured.messages[3]],
  { tools: captured.tools, tool_choice: captured.tool_choice });

// full request, sanitize everything
await probe("FULL body: sanitize all messages",
  [{ role: "system", content: sanitize(sys0) + "\n\n" + sanitize(sys1) }, { role: "user", content: sanitize(captured.messages[2].content) }, { role: "user", content: sanitize(captured.messages[3].content) }],
  { tools: captured.tools, tool_choice: captured.tool_choice });
console.log("\nBISECT5 DONE");
