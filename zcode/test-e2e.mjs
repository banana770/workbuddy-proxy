// E2E test: anthropic-shaped requests against the local proxy.
const BASE = "http://127.0.0.1:8400";

// 1. models
const mres = await fetch(`${BASE}/v1/models`);
const mdoc = await mres.json();
console.log("== /v1/models:", mres.status, "->", mdoc.data?.map((m) => m.id).join(", "));

// 2. non-streaming simple message
const nres = await fetch(`${BASE}/v1/messages`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "test" },
  body: JSON.stringify({
    model: "glm-5.3-flash",
    max_tokens: 3000,
    messages: [{ role: "user", content: "用五个字回答:天空是什么颜色?" }],
  }),
});
const ndoc = await nres.json();
console.log("\n== non-stream:", nres.status);
console.log(JSON.stringify(ndoc, null, 2).slice(0, 900));

// 3. streaming message
console.log("\n== stream:");
const sres = await fetch(`${BASE}/v1/messages`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({
    model: "glm-5.3-flash",
    max_tokens: 3000,
    stream: true,
    messages: [{ role: "user", content: "从1数到5,用顿号分隔" }],
  }),
});
console.log("status", sres.status, sres.headers.get("content-type"));
const stext = await sres.text();
const lines = stext.split("\n").filter((l) => l.startsWith("event:") || l.startsWith("data:"));
console.log(`sse lines: ${lines.length}, event kinds:`, [...new Set(lines.filter((l) => l.startsWith("event:")).map((l) => l.slice(7)))].join(","));
const dataLines = lines.filter((l) => l.startsWith("data:"));
for (const d of dataLines.slice(0, 3)) console.log(" ", d.slice(0, 160));
for (const d of dataLines.slice(-2)) console.log(" ", d.slice(0, 160));

// 4. tool use round (non-stream for assertability)
console.log("\n== tool use:");
const tres = await fetch(`${BASE}/v1/messages`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({
    model: "glm-5.3-flash",
    max_tokens: 4000,
    messages: [
      { role: "user", content: "上海今天天气怎么样?请调用工具查询。" },
    ],
    tools: [{
      name: "get_weather",
      description: "查询城市天气",
      input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    }],
  }),
});
const tdoc = await tres.json();
console.log("status", tres.status, "stop_reason:", tdoc.stop_reason);
console.log(JSON.stringify(tdoc.content, null, 2).slice(0, 800));

// 5. tool_result round
if (tdoc.stop_reason === "tool_use") {
  const toolBlock = tdoc.content.find((b) => b.type === "tool_use");
  const rres = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "glm-5.3-flash",
      max_tokens: 4000,
      messages: [
        { role: "user", content: "上海今天天气怎么样?请调用工具查询。" },
        { role: "assistant", content: [{ type: "tool_use", id: toolBlock.id, name: "get_weather", input: toolBlock.input }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolBlock.id, content: "晴,26度,东南风2级" }] },
      ],
      tools: [{
        name: "get_weather",
        description: "查询城市天气",
        input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      }],
    }),
  });
  const rdoc = await rres.json();
  console.log("\n== tool_result round:", rres.status, "stop:", rdoc.stop_reason);
  const text = (rdoc.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  console.log("final text:", text.slice(0, 300));
}
console.log("\nALL DONE");
