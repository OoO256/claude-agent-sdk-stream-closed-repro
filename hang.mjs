// Edge: the app does work AFTER yielding its final message (so the last turn's
// result can arrive before the input iterable completes). The SDK must still
// terminate promptly, not hang waiting for a result that already came.
import { query } from "@anthropic-ai/claude-agent-sdk";

const VERDICT_FILE = process.env.VERDICT_FILE || "/tmp/hang-v.txt";
const FAKE = new URL("./fake-cli.mjs", import.meta.url).pathname;
const userMsg = (t) => ({ type: "user", message: { role: "user", content: [{ type: "text", text: t }] }, parent_tool_use_id: null });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let release; const firstResult = new Promise((r) => (release = r));
async function* input() {
  yield userMsg("one");
  await firstResult;
  yield userMsg("two");
  await sleep(3000); // <-- post-yield work; the last result arrives during this
}

const start = Date.now();
let timedOut = false;
const to = setTimeout(() => { timedOut = true; console.log("HANG: HARNESS TIMEOUT (the SDK hung)"); process.exit(2); }, 20000);
for await (const m of query({
  prompt: input(),
  options: { canUseTool: async (_n, i) => ({ behavior: "allow", updatedInput: i }), pathToClaudeCodeExecutable: FAKE, executable: "node", settingSources: [], stderr: () => {} },
})) {
  if (m.type === "result") release();
}
clearTimeout(to);
console.log(`HANG: completed in ${((Date.now() - start) / 1000).toFixed(1)}s -> ${timedOut ? "FAIL" : "PASS (terminated)"}`);
