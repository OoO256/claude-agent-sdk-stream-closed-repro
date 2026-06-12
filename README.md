# claude-agent-sdk-stream-closed-repro

Reproduction, a model-free deterministic harness, and a proposed fix for a bug in
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk):
in streaming-input mode the SDK closes the CLI's **stdin** — the bidirectional
control channel that carries in-process MCP tool results, hook callbacks and
`canUseTool` responses — the moment the input iterable completes, as long as
**any** `result` has already been seen. Any in-process tool call made after that
point dies with `Stream closed`; the app's handler is never invoked and the side
effect is silently lost.

See **[SOLUTION.md](./SOLUTION.md)** for the full root-cause analysis and the
readable, source-level version of the fix.

## Two shapes of the bug

- **Repro A** — `repro.mjs`: the last user message's own turn calls an in-process
  MCP tool. The input iterable completes right after that message is yielded,
  `endInput()` fires immediately (an earlier turn's result already satisfied the
  wait), and the tool call seconds later dies. Deterministic.
- **Repro B** — `repro-background.mjs`: a background task settles *after* teardown;
  the CLI continues the conversation from the task notification and its tool call
  dies the same way. This is the real-world (production) shape.

## Setup

```bash
npm install            # installs @anthropic-ai/claude-agent-sdk@0.3.165 + zod
```

The two repros (A and B) drive the **real** CLI and need credentials — either a
logged-in `claude` CLI or `ANTHROPIC_API_KEY`. The deterministic harness does
**not** (no model, no network).

## Reproduce the bug (unpatched)

```bash
# Real, deterministic. Expect: handlerInvocations=0, streamClosedErrors=1
ANTHROPIC_API_KEY=... npm run repro:a

# Model-free, deterministic. Expect: verdict=CHANNEL_CLOSED
npm run harness:a
npm run harness:b
```

`harness.mjs` + `fake-cli.mjs` speak just enough of the SDK stdio control
protocol — with no model — to detect the bug directly: after the input is
exhausted the fake CLI issues a `can_use_tool` round-trip and reports whether the
host can still answer it (`CHANNEL_ALIVE`) or its stdin EOFs first
(`CHANNEL_CLOSED`).

## Apply the fix and re-verify

```bash
npm run patch          # snapshots the pristine bundle, then patches node_modules' sdk.mjs

npm run repro:a        # Expect: handlerInvocations=1, streamClosedErrors=0  (NOT REPRODUCED)
npm run harness:a      # Expect: verdict=CHANNEL_ALIVE
npm run harness:b      # Expect: verdict=CHANNEL_ALIVE
npm run hang           # Edge: app works after its last yield -> terminates ~3s, no hang
npm run regress        # single-turn + streaming-without-bidi still terminate cleanly
```

`apply-patch.mjs` is idempotent: on first run it snapshots the installed bundle
to `node_modules/.../sdk.mjs.orig` (git-ignored — it is Anthropic's distributed
code) and always patches from that snapshot. To restore, reinstall or copy
`sdk.mjs.orig` back over `sdk.mjs`.

## Results

| Test | Unpatched | Patched |
|---|---|---|
| Repro A (real, deterministic) | REPRODUCED | **NOT REPRODUCED** |
| Repro B (real, model-driven) | REPRODUCED | **NOT REPRODUCED** |
| Harness A-shape (model-free) | `CHANNEL_CLOSED` | **`CHANNEL_ALIVE`** |
| Harness B-shape (model-free) | `CHANNEL_CLOSED` | **`CHANNEL_ALIVE`** |
| Regression: single-turn / streaming-no-bidi | clean exit | **clean exit** |
| Edge: work after last `yield` | n/a | **terminates ~3s, no hang** |

## The fix in one line

After the input is exhausted, close the CLI's stdin **at a turn boundary** (when a
`result` arrives and no background task is outstanding) instead of the moment the
input iterable completes. This generalises the SDK's existing single-turn
behaviour (`readMessages` already closes stdin on the first result via
`isSingleUserTurn`) to multi-turn streaming, using only signals the SDK already
receives — no timers, no inactivity heuristics. Details and the readable diff are
in [SOLUTION.md](./SOLUTION.md).

## Files

- `repro.mjs`, `repro-background.mjs` — the two repros
- `fake-cli.mjs`, `harness.mjs` — model-free deterministic harness (A/B shapes)
- `hang.mjs` — edge: the app does work after yielding its last message
- `reg.mjs` — regression checks (single-turn, streaming without bidirectional needs)
- `apply-patch.mjs` — the patch (string-anchored, idempotent, self-snapshotting)
- `SOLUTION.md` — root cause + readable source-level fix + verification

> Verified against `@anthropic-ai/claude-agent-sdk@0.3.165`. Not affiliated with Anthropic.
