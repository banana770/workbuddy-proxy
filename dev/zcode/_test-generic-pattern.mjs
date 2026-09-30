// 本地单测:形状级通用正则的行为(纯本地,不碰上游;不含任何被禁原文)
const P = [
  /\bYou are [A-Z][^.\n]{0,160}?\b(?:code|cli|agent|extension|tool)\b[^.\n]{0,80}\./gi,
  /\bYou're [A-Z][^.\n]{0,160}?\b(?:code|cli|agent|extension|tool)\b[^.\n]{0,80}\./gi,
];
const hit = (s) => P.some((re) => s.match(re) !== null); // match(/g) 每次从头扫,避免 test() 的 lastIndex 状态残留

const shouldHit = [
  'You are ZCode, a terminal coding agent.',
  "You are Claude Code, Anthropic's official CLI for coding.",
  'You are a coding agent running in the X CLI, a terminal-based coding assistant.',
  "You're Gemini CLI, an agent that helps developers.",
];
const shouldMiss = [
  'You are right.',
  'You are an expert gardener.',
  'You are responsible for the result.',
  'As an expert, you should know best.',
];
let ok = true;
for (const s of shouldHit) { const r = hit(s); console.log(r ? '  ✅ 命中(应命中)' : '  ❌ 漏了(应命中)', '→ 长度', s.length); if (!r) ok = false; }
for (const s of shouldMiss) { const r = hit(s); console.log(!r ? '  ✅ 不命中(应放过)' : '  ⚠️ 误伤(应放过)', '→ 长度', s.length); if (r) ok = false; }
console.log(ok ? '\n✅ 形状正则行为符合预期' : '\n❌ 形状正则需要调整');
process.exit(ok ? 0 : 1);
