// Probe WorkBuddy upstream: models catalog + tiny streaming chat.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const authPath = process.env.WORKBUDDY_AUTH_FILE
  ?? join(process.env.LOCALAPPDATA, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info");

const doc = JSON.parse(readFileSync(authPath, "utf8"));
const auth = doc.auth ?? doc;
const uid = doc.account?.uid ?? "";
const token = auth.accessToken;
const domain = auth.domain ?? "";

const CN_CHAT_BASE = "https://copilot.tencent.com";
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";

function commonHeaders() {
  return {
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": "https://www.codebuddy.cn",
    "Referer": "https://www.codebuddy.cn/",
    "User-Agent": CLIENT_UA,
  };
}
function chatHeaders() {
  return {
    ...commonHeaders(),
    "Content-Type": "application/json",
    ...(uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": uid }),
    ...(domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": domain }),
    "X-Product": "SaaS",
  };
}

// 1. Model catalog
const modelsRes = await fetch(`${CN_CHAT_BASE}/console/enterprises/personal/models`, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json", Origin: "https://www.codebuddy.cn", Referer: "https://www.codebuddy.cn/", "User-Agent": CLIENT_UA },
});
console.log("models HTTP", modelsRes.status);
const modelsDoc = await modelsRes.json();
if (modelsDoc.code !== 0) { console.log("models envelope:", JSON.stringify(modelsDoc).slice(0, 400)); process.exit(1); }
const cliAgent = (modelsDoc.data?.agents ?? []).find((a) => a.name === "cli");
console.log("cli agent models:", JSON.stringify(cliAgent?.models ?? null));
const byId = new Map((modelsDoc.data?.models ?? []).map((m) => [m.id, m]));
for (const id of cliAgent?.models ?? []) {
  const m = byId.get(id);
  if (m) console.log(`  ${id.padEnd(20)} in=${m.maxInputTokens} out=${m.maxOutputTokens} img=${m.supportsImages && !m.disabledMultimodal} efforts=${JSON.stringify(m.reasoning?.supportedEfforts ?? m.reasoning?.effort ?? null)} credits=${m.credits ?? "-"}`);
}

// 2. Tiny streaming chat on glm-5.3-flash
const body = {
  model: "glm-5.3-flash",
  messages: [{ role: "user", content: "回复两个字:好的" }],
  stream: true,
  reasoning_effort: "off",
};
const chatRes = await fetch(`${CN_CHAT_BASE}/v2/chat/completions`, {
  method: "POST",
  headers: { ...chatHeaders(), Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});
console.log("\nchat HTTP", chatRes.status, chatRes.headers.get("content-type"));
if (!chatRes.ok) {
  console.log((await chatRes.text()).slice(0, 600));
  process.exit(1);
}
const reader = chatRes.body.getReader();
const dec = new TextDecoder();
let all = "", shown = 0;
while (shown < 2600) {
  const { done, value } = await reader.read();
  if (done) break;
  const text = dec.decode(value, { stream: true });
  all += text;
  process.stdout.write(text);
  shown += text.length;
}
try { reader.cancel(); } catch {}
console.log("\n--- first chunks captured ---");
