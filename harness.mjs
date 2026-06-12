// Deterministic harness app: drives the SDK against the fake CLI, using a
// canUseTool callback (so the SDK has bidirectional needs) and the documented
// streaming-input pattern (msg1, then msg2 after the first result, then the
// input iterable completes). Prints the fake CLI's verdict.
import { query } from "@anthropic-ai/claude-agent-sdk";

const SCENARIO = process.env.SCENARIO || "A";
const VERDICT_FILE = process.env.VERDICT_FILE;
const FAKE = new URL("./fake-cli.mjs", import.meta.url).pathname;

const userMsg = (text) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null });
let release; const firstResult = new Promise((r) => (release = r));
async function* input() {
  yield userMsg("one");
  await firstResult;
  yield userMsg("two");
  // input iterable completes -> exactly the documented streaming pattern
}

let canUseToolCalls = 0;
const to = setTimeout(() => { console.log("HARNESS TIMEOUT"); process.exit(2); }, 30000);
for await (const m of query({
  prompt: input(),
  options: {
    canUseTool: async (_name, inputArgs) => { canUseToolCalls++; return { behavior: "allow", updatedInput: inputArgs }; },
    pathToClaudeCodeExecutable: FAKE,
    executable: "node",
    settingSources: [],
    stderr: () => {},
  },
})) {
  if (m.type === "result") release();
}
clearTimeout(to);

const fs = await import("node:fs");
const verdict = fs.existsSync(VERDICT_FILE) ? fs.readFileSync(VERDICT_FILE, "utf8").trim() : "NO-VERDICT";
console.log(`SCENARIO=${SCENARIO} verdict=${verdict} canUseToolCalls=${canUseToolCalls}`);
