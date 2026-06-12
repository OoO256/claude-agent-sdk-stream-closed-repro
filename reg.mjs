// Regression checks against the patched SDK (real CLI + model):
//  1. single-turn string prompt (no bidirectional needs) terminates with a result
//  2. streaming multi-turn with NO mcp/hooks/canUseTool terminates with results
import { query } from "@anthropic-ai/claude-agent-sdk";

const base = { model: "claude-haiku-4-5", settingSources: [], permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
const userMsg = (t) => ({ type: "user", message: { role: "user", content: [{ type: "text", text: t }] }, parent_tool_use_id: null });

// ---- Test 1: single-turn string prompt -------------------------------------
{
  let results = 0;
  const t = setTimeout(() => { console.log("REG1 TIMEOUT"); process.exit(2); }, 60000);
  for await (const m of query({ prompt: "Reply with exactly: READY", options: base })) {
    if (m.type === "result") results++;
  }
  clearTimeout(t);
  console.log(`REG1 single-turn: results=${results} -> ${results === 1 ? "PASS" : "FAIL"}`);
}

// ---- Test 2: streaming, no bidirectional needs -----------------------------
{
  let results = 0, release;
  const first = new Promise((r) => (release = r));
  async function* input() { yield userMsg("Reply with exactly: ONE"); await first; yield userMsg("Reply with exactly: TWO"); }
  const t = setTimeout(() => { console.log("REG2 TIMEOUT"); process.exit(2); }, 60000);
  for await (const m of query({ prompt: input(), options: base })) {
    if (m.type === "result") { results++; release(); }
  }
  clearTimeout(t);
  console.log(`REG2 streaming-no-bidi: results=${results} -> ${results === 2 ? "PASS" : "FAIL"}`);
}
