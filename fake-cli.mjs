// Deterministic fake `claude` CLI: speaks just enough of the SDK stdio control
// protocol to reproduce the stdin-teardown bug WITHOUT a model.
//
// It detects the bug directly: after the app's input is exhausted, it issues a
// `can_use_tool` control_request (a CLI->host round-trip, exactly like an MCP
// tool call) and checks whether the host can still answer it:
//   - response received           -> CHANNEL_ALIVE   (fixed)
//   - host stdin (our stdin) EOFs  -> CHANNEL_CLOSED  (bug: SDK closed it early)
//
// SCENARIO=A : the tool call happens in the last user message's own turn.
// SCENARIO=B : the tool call happens in a background-task continuation that
//              settles AFTER the input is exhausted.
import { writeFileSync } from "node:fs";

const SCENARIO = process.env.SCENARIO || "A";
const VERDICT_FILE = process.env.VERDICT_FILE || "/tmp/fake-cli-verdict.txt";
const CU_ID = "cu-after-input";

let users = 0;
let awaitingCu = false;
let expectCu = false; // this scenario will issue a post-input tool call
let settled = false;
let stdinEnded = false;
let buf = "";

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const result = (extra = {}) =>
  send({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1", num_turns: 1, ...extra });
const finish = (verdict) => {
  if (settled) return;
  settled = true;
  writeFileSync(VERDICT_FILE, verdict);
  // emit a final result so the (patched) SDK reaches a clean turn boundary, then end output
  result();
  setTimeout(() => process.exit(0), 50);
};

const sendCanUseTool = () => {
  awaitingCu = true;
  send({ type: "control_request", request_id: CU_ID, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo hi" } } });
  // if the host already EOF'd our stdin, its response can never reach us
  if (stdinEnded) finish("CHANNEL_CLOSED");
};

function onMessage(m) {
  if (m.type === "control_request" && m.request?.subtype === "initialize") {
    send({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { commands: [], roots: [], output_style: "default" } } });
    return;
  }
  if (m.type === "control_response" && m.response?.request_id === CU_ID) {
    // the host answered our post-input tool call -> the control channel survived
    finish("CHANNEL_ALIVE");
    return;
  }
  if (m.type === "user") {
    users++;
    if (users === 1) {
      if (SCENARIO === "B") send({ type: "system", subtype: "task_started", task_id: "T1" });
      // first turn's result -> releases the app's follow-up (msg2)
      result(SCENARIO === "B" ? { origin: { kind: "task-notification" } } : {});
    } else if (users === 2) {
      // input is now exhausted from the app's side.
      if (SCENARIO === "HANG") {
        // no tool call, no tasks: emit the last turn's result right away (it may
        // arrive while the app is still doing post-yield work). The SDK must
        // still terminate promptly, not hang.
        result();
        return;
      }
      expectCu = true; // both A and B issue a tool call after the input is exhausted
      if (SCENARIO === "A") {
        // last message's own turn reaches a tool call a beat later
        setTimeout(sendCanUseTool, 300);
      } else {
        // ack msg2, keep a background task pending, settle it later, then the
        // task-notification continuation issues the tool call
        result();
        setTimeout(() => {
          send({ type: "system", subtype: "task_notification", task_id: "T1", status: "completed" });
          setTimeout(sendCanUseTool, 200);
        }, 1000);
      }
    }
  }
}

process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    try { onMessage(m); } catch {}
  }
});

process.stdin.on("end", () => {
  // host closed our stdin (endInput).
  stdinEnded = true;
  if (settled) return;
  if (awaitingCu || expectCu) finish("CHANNEL_CLOSED"); // a (pending) tool-call answer can never arrive -> the bug
  else { settled = true; writeFileSync(VERDICT_FILE, "TERMINATED"); process.exit(0); } // clean shutdown
});

setTimeout(() => finish("TIMEOUT"), 15000);
