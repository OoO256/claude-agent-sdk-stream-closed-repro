// Re-runnable patch for issue: "SDK closes the CLI control channel
// mid-conversation". Transforms a pristine sdk.mjs -> a patched sdk.mjs.
//
// Run AFTER `npm install` (which installs @anthropic-ai/claude-agent-sdk@0.3.165):
//     node apply-patch.mjs
// On first run it snapshots the pristine bundle to sdk.mjs.orig, then always
// patches from that snapshot, so it is safe to run repeatedly.
//
// Fix: in streaming-input mode, close the CLI's stdin (the bidirectional
// control channel) at a TURN BOUNDARY -- when a `result` arrives after the
// input is exhausted, and no background task is still outstanding -- instead of
// the moment the input iterable completes (which today closes mid-turn as soon
// as ANY earlier result was seen, killing in-flight MCP tool calls / hooks /
// canUseTool with "Stream closed"). See SOLUTION.md for the readable source-level
// version of this change.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SDK_DIR = fileURLToPath(new URL("./node_modules/@anthropic-ai/claude-agent-sdk/", import.meta.url));
const SDK = `${SDK_DIR}sdk.mjs`;
const ORIG = `${SDK_DIR}sdk.mjs.orig`;

if (!existsSync(SDK)) {
  console.error(`Cannot find ${SDK}\nRun \`npm install\` first (installs @anthropic-ai/claude-agent-sdk@0.3.165).`);
  process.exit(1);
}
// Snapshot the pristine bundle once, then always patch from it.
if (!existsSync(ORIG)) { copyFileSync(SDK, ORIG); console.log("snapshotted pristine bundle -> sdk.mjs.orig"); }

let src = readFileSync(ORIG, "utf8");

function replaceOnce(needle, replacement, expected = 1) {
  const n = src.split(needle).length - 1;
  if (n !== expected) throw new Error(`anchor count ${n} !== ${expected} for: ${needle.slice(0, 70)}...`);
  src = src.split(needle).join(replacement);
}

// ---- INJECTION 0: two small methods, appended after waitForFirstResult() ----
//  __noteForShutdown    : per-message bookkeeping (result count + task ledger)
//  __maybeFinishStreaming: the close decision, evaluated at each turn boundary
const wffrTail = `addEventListener("abort",()=>e(),{once:!0}),this.firstResultReceivedResolve=e})}`;
const injected =
  `__noteForShutdown(e){if(!e||typeof e!=="object")return;if(e.type==="result"){this.__resultCount=(this.__resultCount||0)+1;this.__maybeFinishStreaming()}else if(e.type==="system"){let t=e.subtype;if(t==="task_started")(this.__tasks||(this.__tasks=new Set)).add(e.task_id);else if(t==="task_notification")this.__tasks&&this.__tasks.delete(e.task_id)}}` +
  `__maybeFinishStreaming(){if(!this.__inputComplete)return;if(this.hasBidirectionalNeeds()){if((this.__resultCount||0)<=(this.__lastWriteResultCount||0))return;if(this.__tasks&&this.__tasks.size>0)return}this.transport.endInput()}`;
replaceOnce(wffrTail, wffrTail + injected);

// ---- INJECTION 1: observe every CLI->host message in the read loop ----------
replaceOnce(
  `for await(let e of this.transport.readMessages()){if(e.type==="control_response"){`,
  `for await(let e of this.transport.readMessages()){this.__noteForShutdown(e);if(e.type==="control_response"){`,
);

// ---- INJECTION 2: remember results-seen as of each input write, so the close
// waits for a result that is FRESH relative to the last message (and never
// hangs if the app does work after yielding its final message). --------------
replaceOnce(
  `this.abortController?.signal.aborted)break;await Promise.resolve(this.transport.write(pe(r)`,
  `this.abortController?.signal.aborted)break;this.__lastWriteResultCount=this.__resultCount||0;await Promise.resolve(this.transport.write(pe(r)`,
);

// ---- INJECTION 3: streamInput marks input complete & defers the close to the
// turn-boundary check, instead of closing stdin immediately. -----------------
replaceOnce(
  `)ne("[Query.streamInput] Has bidirectional needs, waiting for first result"),await this.waitForFirstResult();ne("[Query] Calling transport.endInput() to close stdin to CLI process"),this.transport.endInput()`,
  `){this.__inputComplete=!0;this.__maybeFinishStreaming()}else{ne("[Query] Calling transport.endInput() to close stdin to CLI process"),this.transport.endInput()}`,
);

writeFileSync(SDK, src, "utf8");
console.log("patched sdk.mjs written:", src.length, "bytes (orig +", src.length - readFileSync(ORIG, "utf8").length, ")");
