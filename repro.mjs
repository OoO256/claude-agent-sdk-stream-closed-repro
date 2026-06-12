/**
 * Repro: the SDK closes the CLI's stdin (control channel) the moment the
 * input iterable completes — even though the CLI is still processing the
 * message the app just sent. Any in-process SDK MCP tool call in that turn
 * fails with "Stream closed"; the app's handler is never invoked.
 *
 * Scenario (minimal multi-turn streaming-input app — documented pattern):
 *   - msg 1: "Reply READY"            → model replies; a `result` is emitted
 *   - msg 2: "call record_result"     → the app has nothing more to send,
 *     so the input iterable completes right after yielding it
 *   - SDK: input exhausted + a result already seen → endInput() → stdin closed
 *   - the model — mid-turn on msg 2 — calls `record_result`
 *   → "Stream closed". handlerInvocations stays 0; the outcome is silently lost.
 *
 * No background tasks, no timers, no delays. ~15s, any model.
 *
 * Setup:  npm i @anthropic-ai/claude-agent-sdk@0.3.165 zod
 * Run:    ANTHROPIC_API_KEY=... node repro.mjs
 */
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// ---- the in-process MCP tool the app exposes --------------------------------
let handlerInvocations = 0;
const server = createSdkMcpServer({
  name: "app",
  tools: [
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

// ---- streaming input: two messages, the second sent after the first reply ---
const MSG_1 = "Reply with exactly: READY. Do not call any tools.";
const MSG_2 =
  "Now call mcp__app__record_result once with summary='hello' and report what it returns.";

const userMsg = (text) => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
  parent_tool_use_id: null,
});

let releaseFollowUp;
const firstResultSeen = new Promise((resolve) => (releaseFollowUp = resolve));

async function* input() {
  yield userMsg(MSG_1);
  await firstResultSeen; // send the follow-up only after the model has answered
  yield userMsg(MSG_2);
  // generator returns → input exhausted, like any app that has nothing more to send
}

// ---- run ---------------------------------------------------------------------
const streamClosedErrors = [];
let recorded = false;
let resultCount = 0;

const timeout = setTimeout(() => {
  console.log("TIMEOUT after 120s");
  process.exit(2);
}, 120_000);

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
