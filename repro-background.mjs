/**
 * Repro B (background-continuation variant): the real-world shape.
 *
 * An in-process MCP tool call made in a background-task continuation — after
 * the SDK has torn down the control channel — fails with "Stream closed".
 *
 *   - msg 1: launch a background agent that calls `generate_result` (a ~25s tool)
 *   - msg 2: "when the job completes, call `record_result`" → model acks; input exhausts
 *   - SDK: input exhausted + a result already seen → endInput() → stdin closed
 *   - ~25s later the agent settles → the CLI continues from the task notification
 *     and calls `record_result`
 *   → "Stream closed"; record_result's handler is NEVER invoked (handlerInvocations=0).
 *
 * Note the trace shows `generate_result` *succeeds* (its handler runs +9s→+34s):
 * it was called while the channel was still alive. record_result, called in the
 * post-teardown continuation, is the one that dies — pinning the teardown moment
 * between the two calls. This is the flavor that hit us in production.
 *
 * Setup:  npm i @anthropic-ai/claude-agent-sdk@0.3.165 zod
 * Run:    ANTHROPIC_API_KEY=... node repro-background.mjs
 */
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// ---- in-process MCP tools the app exposes -----------------------------------
const t0 = Date.now();
const at = () => `+${Math.round((Date.now() - t0) / 1000)}s`;
let handlerInvocations = 0;
const server = createSdkMcpServer({
  name: "app",
  tools: [
    tool(
      "generate_result",
      "Generates the result of a job. Always takes about 25 seconds.",
      { job: z.string().describe("what to generate") },
      async (args) => {
        console.log(`[generate_result] handler started ${at()}`);
        await new Promise((resolve) => setTimeout(resolve, 25_000));
        console.log(`[generate_result] handler finished ${at()}`);
        return { content: [{ type: "text", text: `generated: result for ${args.job}` }] };
      },
    ),
    tool(
      "record_result",
      "Persists the final outcome of a job. Call when work completes.",
      { summary: z.string().describe("one-line outcome summary") },
      async (args) => {
        handlerInvocations++;
        return { content: [{ type: "text", text: `recorded: ${args.summary}` }] };
      },
    ),
  ],
});

// ---- streaming input: two messages, the second sent after the first result --
const userMsg = (text) => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
  parent_tool_use_id: null,
});

let releaseFollowUp;
const firstResultSeen = new Promise((resolve) => (releaseFollowUp = resolve));

async function* input() {
  yield userMsg(MSG_1);
  await firstResultSeen; // wait until the model has answered message 1
  yield userMsg(MSG_2);
  // generator returns → input exhausted, like any app that has nothing more to send
}

const MSG_1 = [
  "Use the Agent tool (run_in_background: true, general-purpose) to run this task:",
  '"Call mcp__app__generate_result once with job=\'demo\' and report its output."',
  "Just tell me once it's started.",
].join("\n");

const MSG_2 =
  "Thanks. When the background job completes, call mcp__app__record_result once with a one-line summary.";

// ---- run --------------------------------------------------------------------
const streamClosedErrors = [];
let recorded = false;
let resultCount = 0;

const timeout = setTimeout(() => {
  console.log("TIMEOUT after 240s");
  process.exit(2);
}, 240_000);

for await (const msg of query({
  prompt: input(),
  options: {
    mcpServers: { app: server },
    model: "claude-haiku-4-5", // reproduces with any model
    settingSources: [],        // hermetic — no user/project settings
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  },
})) {
  if (msg.type === "result") {
    resultCount++;
    console.log(`[result #${resultCount}]`);
    releaseFollowUp();
  } else if (msg.type === "system" && (msg.subtype === "task_started" || msg.subtype === "task_notification")) {
    console.log(`[${msg.subtype}] task=${msg.task_id} ${msg.status ?? ""}`);
  } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
    for (const blk of msg.message.content) {
      if (blk.type !== "tool_result") continue;
      const text = Array.isArray(blk.content)
        ? blk.content.map((c) => c?.text ?? "").join(" ")
        : String(blk.content ?? "");
      if (blk.is_error) {
        console.log(`[tool_result ERROR] ${text.slice(0, 90)}`);
        if (/stream closed/i.test(text)) streamClosedErrors.push(text);
      } else if (/recorded:/.test(text)) {
        console.log(`[tool_result OK] ${text.slice(0, 90)}`);
        recorded = true;
      }
    }
  }
}
clearTimeout(timeout);

console.log("---");
console.log(`results=${resultCount} handlerInvocations=${handlerInvocations} streamClosedErrors=${streamClosedErrors.length}`);
if (streamClosedErrors.length > 0 && handlerInvocations === 0) {
  console.log("VERDICT: REPRODUCED — record_result died in the bridge; app handler never ran, outcome silently lost");
} else if (recorded) {
  console.log("VERDICT: NOT REPRODUCED — tool call succeeded");
} else {
  console.log("VERDICT: INCONCLUSIVE");
}
