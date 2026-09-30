// E2E test: OpenAI chat-completions shaped requests against the codex proxy.
const BASE = "http://127.0.0.1:8401";
const H = { "Content-Type": "application/json" };

// 1. models
const mres = await fetch(`${BASE}/v1/models`);
const mdoc = await mres.json();
console.log("== /v1/models:", mres.status, "->", mdoc.data?.map((m) => m.id).join(", "));

// 2. non-streaming (Codex uses streaming, but verify aggregation)
const nres = await fetch(`${BASE}/v1/chat/completions`, {
  method: "POST", headers: H,
  body: JSON.stringify({
    model: "glm-5.3-flash",
    stream: false,
    messages: [
      { role: "developer", content: "你是简洁助手,只回答一个词。" },
      { role: "user", content: "天空是什么颜色?" },
    ],
    reasoning_effort: "low",
  }),
});
const ndoc = await nres.json();
console.log("\n== non-stream:", nres.status, "finish:", ndoc.choices?.[0]?.finish_reason);
console.log("content:", JSON.stringify(ndoc.choices?.[0]?.message?.content)?.slice(0, 120));
console.log("reasoning chars:", ndoc.choices?.[0]?.message?.reasoning_content?.length ?? 0);
console.log("usage:", JSON.stringify(ndoc.usage));

// 3. streaming with tools
const sres = await fetch(`${BASE}/v1/chat/completions`, {
  method: "POST", headers: H,
  body: JSON.stringify({
    model: "glm-5.3-flash",
    stream: true,
    stream_options: { include_usage: true },
    store: false,
    prompt_cache_key: "test-cache-key",
    messages: [{ role: "user", content: "上海今天天气如何?必须调用 get_weather 工具查询。" }],
    tools: [{
      type: "function",
      function: {
        name: "get_weather",
        description: "查询城市天气",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    }],
    tool_choice: { type: "function", function: { name: "get_weather" } },
  }),
});
console.log("\n== stream+tools:", sres.status, sres.headers.get("content-type"));
const stext = await sres.text();
const chunks = stext.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter((p) => p && p !== "[DONE]");
console.log("chunks:", chunks.length, "saw [DONE]:", stext.includes("[DONE]"));
const toolFrag = [];
let finalFinish = null;
let sawReasoning = 0;
for (const c of chunks) {
  try {
    const j = JSON.parse(c);
    const d = j.choices?.[0]?.delta ?? {};
    if (d.reasoning_content) sawReasoning += d.reasoning_content.length;
    if (Array.isArray(d.tool_calls)) for (const t of d.tool_calls) toolFrag.push(t);
    if (j.choices?.[0]?.finish_reason) finalFinish = j.choices[0].finish_reason;
  } catch {}
}
const name = toolFrag.find((t) => t.function?.name)?.function?.name;
const args = toolFrag.map((t) => t.function?.arguments ?? "").join("");
console.log("finish_reason:", finalFinish, "| tool:", name, "| args:", args.slice(0, 80), "| reasoning chars:", sawReasoning);

// 4. tool_result round trip
if (name) {
  const callId = toolFrag.find((t) => t.id)?.id;
  const rres = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST", headers: H,
    body: JSON.stringify({
      model: "glm-5.3-flash",
      stream: false,
      messages: [
        { role: "user", content: "上海今天天气如何?" },
        { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: "get_weather", arguments: args || "{}" } }] },
        { role: "tool", tool_call_id: callId, content: "晴,26度,东南风2级" },
      ],
      tools: [{
        type: "function",
        function: { name: "get_weather", description: "查询城市天气", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
      }],
    }),
  });
  const rdoc = await rres.json();
  console.log("\n== tool_result round:", rres.status, "finish:", rdoc.choices?.[0]?.finish_reason);
  console.log("answer:", JSON.stringify(rdoc.choices?.[0]?.message?.content)?.slice(0, 220));
}
console.log("\nALL DONE");
