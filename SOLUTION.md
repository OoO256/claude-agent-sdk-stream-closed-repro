# Fix: SDK closes the CLI control channel mid-conversation (issue #201)

## Problem

In streaming-input mode the SDK closes the CLI's **stdin** the moment the input
iterable completes, as long as **any** `result` has already been seen. stdin is
the bidirectional control channel — it carries in-process MCP tool results, hook
callbacks and `canUseTool` responses back to the CLI. Closing it mid-conversation
makes every later tool call die with `Stream closed`; the app's handler is never
invoked and the side effect is silently lost.

Two ordinary shapes (the issue's Repro A / Repro B):

- **A** — the last user message's own turn calls an in-process tool. The input
  iterable completes right after that message is yielded, `endInput()` fires
  immediately (an earlier turn's result already satisfied the wait), and the
  tool call seconds later dies. Deterministic.
- **B** — a background task settles after teardown; the CLI continues from the
  task notification and its tool call dies the same way.

## Root cause (from the de-minified `Query`)

```js
streamInput(inputStream) {
  let count = 0;
  for await (const m of inputStream) { count++; this.transport.write(serialize(m) + "\n"); }
  if (count > 0 && this.hasBidirectionalNeeds())
    await this.waitForFirstResult();   // resolves on ANY prior result
  this.transport.endInput();            // stdin.end() -> kills the control channel
}
```

`endInput()` (`= processStdin.end()`, an EOF) is overloaded: it means both *"no
more user input"* **and** *"tear down the control-response path"*. Those have
different lifetimes — input can end early, but the control channel is needed for
as long as the CLI is still working. `waitForFirstResult()` resolves on *any*
earlier result and consults neither the in-flight turn nor the task registry, so
the close lands in the middle of a turn / before a background continuation.

The SDK already does the right thing for **single-turn** queries: in
`readMessages` it closes stdin on the first `result` (the `isSingleUserTurn`
branch) — i.e. *at a turn boundary*. The streaming path just never got that
treatment.

## Fix — close at a turn boundary, from `readMessages`, using signals the SDK already has

Generalise the single-turn rule to multi-turn streaming: after the input is
exhausted, close stdin **when a `result` arrives** (a turn boundary — the CLI is
never mid-turn at a result) **and no background task is still outstanding** (so no
task-notification continuation can start another turn). No timers, no inactivity
heuristics — only `result` messages and the `task_started` / `task_notification`
system messages the SDK already receives.

```ts
class Query {
  private inputComplete = false;
  private resultCount = 0;
  private resultCountAtLastWrite = 0;          // results seen as of the last input write
  private outstandingTasks = new Set<string>();

  async streamInput(inputStream) {
    let count = 0;
    for await (const m of inputStream) {
      count++;
      if (this.abortController?.signal.aborted) break;
      this.resultCountAtLastWrite = this.resultCount;     // (1)
      await this.transport.write(serialize(m) + "\n");
    }
    if (count > 0 && this.hasBidirectionalNeeds()) {
      this.inputComplete = true;                          // (2) defer the close…
      this.maybeFinishStreaming();                        //     …to the turn-boundary check
    } else {
      this.transport.endInput();                          // unchanged: nothing bidirectional to protect
    }
  }

  /** called for every message read from the CLI */
  private noteForShutdown(m) {
    if (m?.type === "result") { this.resultCount++; this.maybeFinishStreaming(); }
    else if (m?.type === "system") {
      if (m.subtype === "task_started")       this.outstandingTasks.add(m.task_id);
      else if (m.subtype === "task_notification") this.outstandingTasks.delete(m.task_id);
    }
  }

  /** close stdin only once the conversation is actually over */
  private maybeFinishStreaming() {
    if (!this.inputComplete) return;
    if (this.hasBidirectionalNeeds()) {
      if (this.resultCount <= this.resultCountAtLastWrite) return; // wait for the LAST turn's result
      if (this.outstandingTasks.size > 0) return;                  // wait for background continuations
    }
    this.transport.endInput();
  }

  async readMessages() {
    for await (const m of this.transport.readMessages()) {
      this.noteForShutdown(m);                            // (3)
      /* …existing dispatch unchanged… */
    }
  }
}
```

Three one-line edits ((1)(2)(3)) plus two small private methods. `streamInput`
no longer eagerly closes; `readMessages` drives the close at turn boundaries,
exactly like the existing single-turn path.

Why each guard:

- `resultCount > resultCountAtLastWrite` — wait for the result of the **last**
  message we sent (not a stale earlier one). Fixes **A**. Capturing the count *at
  the last write* also means an app that does work *after* yielding its final
  message never hangs (the already-arrived result still counts as fresh).
- `outstandingTasks.size === 0` — a background task's completion triggers a
  *continuation turn* whose tool call must survive. Stay open until the ledger is
  empty. Fixes **B**.
- Evaluating only at `result` boundaries (never on `task_notification`) means we
  never close in the gap between "task done" and "continuation's tool call", and
  never mid-turn — which also dissolves the long-tool variant (#114): a slow tool
  runs *inside* a turn, and we only close after that turn's result.

## Why this should satisfy a maintainer

- **Minimal & surgical.** Three one-line edits + two small methods. The
  bidirectional-needs gate is preserved, so non-MCP/non-hook queries are
  completely unchanged.
- **Natural.** It reuses the SDK's own model — "close stdin at a turn boundary"
  — already implemented for single-turn in `readMessages`. No new concepts.
- **No timers / no inactivity heuristics.** Past fixes kept changing *how the SDK
  guesses the conversation is over* (`waitForInactivity` → `waitForFirstResult`),
  so the failure kept moving (#114 → this). This removes the guess: the close is
  driven by the CLI's own turn/task signals.
- **Deterministically testable** without a model (harness below) — suitable as a
  regression test.

Assumption / trade-off: a started background task eventually emits a terminal
`task_notification` (true for the CLI; same assumption the reporter's host-side
workaround makes). If one never did, the query would stay open longer rather than
close — strictly safer than today's premature close.

## Verification

Patch applied to `@anthropic-ai/claude-agent-sdk@0.3.165`'s `sdk.mjs` via
`apply-patch.mjs` (pristine `sdk.mjs.orig` → `sdk.mjs`; each anchor asserted).
The two repros were run **unmodified**.

| Test | Unpatched | Patched |
|---|---|---|
| Repro A (real, deterministic) | REPRODUCED 7/7 in issue, 1/1 here | **NOT REPRODUCED 4/4** |
| Repro B (real, model-driven) | REPRODUCED (issue) | **NOT REPRODUCED 5/5** (runs where the model issued `record_result`) |
| Deterministic harness, A-shape | CHANNEL_CLOSED | **CHANNEL_ALIVE** |
| Deterministic harness, B-shape | CHANNEL_CLOSED | **CHANNEL_ALIVE** |
| Regression: single-turn string prompt | result, exits | **result, exits** |
| Regression: streaming, no bidirectional needs | 2 results, exits | **2 results, exits** |
| Edge: app does work after last `yield` | n/a | **terminates in 3.0s (no hang)** |

The deterministic harness (`fake-cli.mjs` + `harness.mjs`) speaks the stdio
control protocol with no model: after the input is exhausted it issues a
`can_use_tool` round-trip and checks whether the host can still answer it
(`CHANNEL_ALIVE`) or its stdin EOFs first (`CHANNEL_CLOSED`). It reproduces both
shapes on the unpatched SDK and confirms the fix — and doubles as a fast,
model-free regression test.

### Files
- `apply-patch.mjs` — the patch (string-anchored, idempotent; snapshots the
  installed bundle to `sdk.mjs.orig` on first run, then always patches from it)
- `repro.mjs`, `repro-background.mjs` — the issue's two repros, verbatim
- `fake-cli.mjs`, `harness.mjs`, `hang.mjs` — deterministic, model-free harness
- `reg.mjs` — regression checks
- See `README.md` for run commands.
