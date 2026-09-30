// Bisect 3: is 11128 triggered by system-prompt LENGTH or by its CONTENT?
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

async function probe(label, systemContent) {
  const body = { model: "glm-5.3-flash", stream: true, messages: [{ role: "system", content: systemContent }, { role: "user", content: "只回复:OK" }] };
  const res = await fetch(`${base}/v2/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
  if (res.ok) { await res.text(); console.log(`${label.padEnd(52)} OK`); return true; }
  const text = await res.text();
  let info = `HTTP ${res.status}`;
  try { const j = JSON.parse(text); info += ` code=${j.code}`; } catch {}
  console.log(`${label.padEnd(52)} ${info}`);
  return false;
}

// length-only tests (neutral filler)
await probe("neutral filler 500 chars", "你是简洁助手。" + "这是一段中性的说明文字。".repeat(40));
await probe("neutral filler 5k chars", "你是简洁助手。" + "这是一段中性的说明文字。".repeat(400));
await probe("neutral filler 21k chars", "你是简洁助手。" + "这是一段中性的说明文字。".repeat(1600));

// content tests on the real prompt
await probe("real system head 200 chars", sys0.slice(0, 200));
await probe("real system head 1000 chars", sys0.slice(0, 1000));
await probe("real system head 5000 chars", sys0.slice(0, 5000));
await probe("real system FULL", sys0);

// neutralize identity words in the real prompt
const neutral = sys0
  .replaceAll("Codex CLI", "the terminal assistant")
  .replaceAll("Codex", "the assistant")
  .replaceAll("OpenAI", "the vendor")
  .replaceAll("codex", "assistant");
await probe("real system, Codex/OpenAI renamed (full len)", neutral);
await probe("real system head 1000, renamed", neutral.slice(0, 1000));
console.log("\nBISECT3 DONE");
