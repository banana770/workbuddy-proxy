// Bisect 4: which roles/strings trigger 11128, and does merging system messages fix 11133?
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
  if (res.ok) { await res.text(); console.log(`${label.padEnd(54)} OK`); return true; }
  const text = await res.text();
  let info = `HTTP ${res.status}`;
  try { const j = JSON.parse(text); info += ` code=${j.code}`; } catch {}
  console.log(`${label.padEnd(54)} ${info}`);
  return false;
}

const sanitize = (s) => s
  .replace(/Codex CLI/gi, "the coding assistant")
  .replace(/Codex/gi, "the assistant")
  .replace(/OpenAI/gi, "the vendor");

// does a USER message with identity words trip it?
await probe("user says 'Codex CLI'", [{ role: "system", content: "你是简洁助手。" }, { role: "user", content: "You are a coding agent running in the Codex CLI, built by OpenAI. 只回复:OK" }]);
await probe("user says 'codex' lowercase", [{ role: "system", content: "你是简洁助手。" }, { role: "user", content: "please look at codex config. 只回复:OK" }]);

// system identity words
await probe("system says 'Codex CLI' only", [{ role: "system", content: "You are a coding agent running in the Codex CLI. 你是简洁助手。" }, { role: "user", content: "只回复:OK" }]);
await probe("system says 'Codex' only", [{ role: "system", content: "You are Codex. 你是简洁助手。" }, { role: "user", content: "只回复:OK" }]);
await probe("system says 'OpenAI' only", [{ role: "system", content: "Made by OpenAI. 你是简洁助手。" }, { role: "user", content: "只回复:OK" }]);
await probe("system 'codex' lowercase", [{ role: "system", content: "read codex docs. 你是简洁助手。" }, { role: "user", content: "只回复:OK" }]);

// merged system messages (fix for 11133)
await probe("two system msgs merged into one (sanitized)",
  [{ role: "system", content: sanitize(sys0) + "\n\n" + sanitize(sys1) }, { role: "user", content: "只回复:OK" }]);
await probe("two separate system msgs (expect 11133)",
  [{ role: "system", content: sanitize(sys0) }, { role: "system", content: sanitize(sys1) }, { role: "user", content: "只回复:OK" }]);

// full captured body, sanitized + merged + tools
await probe("FULL codex body sanitized+merged+tools", [
  { role: "system", content: sanitize(sys0) + "\n\n" + sanitize(sys1) },
  { role: "user", content: sanitize(captured.messages[2].content) },
  { role: "user", content: captured.messages[3].content },
], {}, );
console.log("\nBISECT4 DONE");
