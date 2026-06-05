# AI Workflow

This document is an honest record of how I used AI tooling (Claude) to build this submission, what I asked it to do, where it got things wrong, and the decisions I made that overrode its defaults.

The goal of this writeup is not to claim I wrote every keystroke myself, nor to pretend AI generated a finished product. The reality is in between: I used AI as a fast first-draft generator and a thinking partner, then made architectural and correctness decisions that took the result from "demo-quality" to "submission-quality."

---

## 1. How the work was structured

I split the build into nine tracked tasks, each with a clear deliverable:

1. Scaffold (Vite + React + TS + Tailwind + Zustand + Vitest)
2. Core type definitions and the state-machine spec
3. Simulation layer
4. MetricsEngine
5. Orchestrator + FailoverManager
6. Zustand store + rAF binding
7. UI components
8. Tests
9. Documentation + Vercel config

Each layer was specified before code: types and invariants first, implementations second. This is how I avoided the most common AI-coding failure mode — generating plausible-looking code that doesn't compose with the rest of the system.

---

## 2. Architecture prompts I used

### 2.1 Setting the design rules

Before any implementation, I instructed Claude to write a layered architecture with these rules:

- The orchestrator depends only on a `NodeClient` interface, never on the simulator.
- The store never sees per-chunk events directly — they must be coalesced.
- The metrics engine takes an injected `now()` so virtual time is testable.
- The state machine must be an enumerable union of string literals, not a class field with implicit transitions.

These were prescriptive constraints, not "design it nicely." Without them the model defaults to common React-app patterns (useEffect everywhere, state thrash, no clear seam between IO and orchestration).

### 2.2 The "explicit state machine" prompt

I asked specifically for `OrchestratorState` to be a discriminated union and for every transition to emit a `{type: 'state', from, to}` event. The model's instinct was to track state as a class field and update it imperatively. I rejected that draft because it makes failover behavior unobservable from the outside — you can't write a test that asserts "we transitioned through `failing-over` exactly twice" without inspecting private state.

### 2.3 The "offset-continuation" prompt

The most important architectural decision in the project. I prompted Claude to choose between three failover strategies and justify the choice:

1. **Text-level deduplication after reconnect.** Robust to any node behavior but heuristic, and ambiguous when the corpus contains repeated tokens.
2. **Last-byte offset.** Works for raw byte streams but doesn't compose with tokenized output.
3. **Token-index protocol.** Each chunk carries a monotonic index; orchestrator commits only on `index === expected + 1`; resume passes `resumeFrom = expected`.

Claude initially recommended (1). I pushed back on the ambiguity around repeated tokens (the corpus literally contains "the" twice) and we converged on (3). The duplicate-index test in `Orchestrator.test.ts` exists specifically to prove this contract holds even against a non-compliant node.

---

## 3. AI-generated mistakes I caught and corrected

These are the real ones, in the order I hit them.

### 3.1 TTFT being reset on failover

The first draft of `MetricsEngine` had `recordTokens` overwrite `ttftMs` on every call. It looked right in isolation. But when a node drops before yielding any token and the orchestrator fails over, TTFT should still measure from `markStart()` to the *first chunk the user actually sees*, not from the moment of the second node's first byte. I changed it to `if (this.ttftMs === null)` so TTFT is set exactly once. The fix is one line; the *thinking* is the whole point.

### 3.2 Naive TPS using cumulative average

The first draft of TPS was `totalTokens / elapsedSeconds`. That's a moving average, not a rolling window — it understates TPS at the end of a long stream because the early ramp-up never expires. The fix was a deque-based sliding window with explicit eviction.

A subtler issue: even with the deque, dividing by a hardcoded `1000` underreports TPS for the first second of streaming. I added the `span = min(1000, now - oldest)` clamp so early-stream values are accurate too. See `MetricsEngine.test.ts`'s "evicts events older than 1000ms" case — it specifically catches the early-window underreporting.

### 3.3 Per-chunk `set()` in the store

The default Claude pattern for streaming output in React is to call `useStore.setState({ text: text + chunk })` on every chunk. For a 200 tps stream that's 200 store updates per second, which means at least 200 re-renders of every subscribed component. The first version I generated did exactly this.

The fix is the rAF-coalesced binding in `src/store/store.ts`: a ring buffer in a closure, flushed on `requestAnimationFrame`. One `set()` per frame. This single change is what makes the UI usable at high TPS, and it's the kind of optimization an AI won't apply unless you specifically ask "what's our render rate at 200 tps?"

### 3.4 No abort on failover

The first draft of `Orchestrator.runAttempt` didn't actually abort the failing node's stream before opening the next one. It looked correct because the failing iterator threw, but a `latency-spike` fault is not a throw — it's a stall. Without abort, a spiking node would still be sitting in `setTimeout` after we'd already moved on, and might yield a late chunk that the orchestrator's index-equality check would either commit incorrectly or (correctly) reject as a duplicate. Either way, wasted work and confusing logs.

The fix: per-attempt `AbortController`, with the simulator listening to the signal and the orchestrator aborting both on stall (via timeout race) and on attempt teardown.

### 3.5 Circuit-breaker fairness

Claude's initial breaker would open after one failure. I corrected this to two consecutive failures (the threshold is configurable), because a single transient drop shouldn't quarantine a node — especially with three nodes total. A one-failure trip combined with bad luck could blacklist two-of-three nodes before the third has even been tried.

### 3.6 NodeHealth mutable shared reference

`FailoverManager` was mutating the `NodeHealth` object in place (`h.chunksDelivered += 1`, `h.circuit = 'open'`), then passing the same reference into the Zustand store via `_setNodeHealth`. Zustand's store does a spread of the enclosing record (`{ ...s.nodes.health, [id]: h }`) so the `health` record itself is a new object and NodeStatusPanel does re-render — but the individual health object inside is the **same reference** as the one still held by FailoverManager. Any future mutation by FailoverManager would change the value already in the store without a `set()` call, making the store's state silently stale.

Fixed by making `reportChunk` and `reportFailure` return new health objects (`{ ...h, field: newValue }`) instead of mutating in place. This is the classic React/Zustand immutability rule — it just applied one layer below the store.

### 3.7 `raceWithTimeout` placeholder nodeId

The timeout race was creating `new NodeError('node-a', 'timeout')` with a hardcoded placeholder, then patching it in `toNodeError` with the real nodeId. It worked because the patching always happened — but it was a trap: if the error ever propagated to a different catch scope (e.g. if `runAttempt` had been refactored to re-throw from an inner catch), the wrong nodeId would appear in the event log. Fixed by threading `nodeId` into `raceWithTimeout` directly.

### 3.8 Selection deadlock when all circuits open

The first selection function returned `null` when no node was eligible, and the orchestrator loop just kept calling it. With three nodes and a string of failures, the loop would sleep forever. I added a last-resort fallback that allows the most-recently-failed node back in if literally no other choice exists, and a `sleepUntilNextCooldown` helper so we wake at the right moment instead of busy-polling.

---

## 4. Engineering decisions I made deliberately

These are the calls that aren't obvious from the code and that an AI wouldn't naturally make.

- **`maxAttempts` is bounded.** A real production client would retry indefinitely with backoff; for an assignment we cap at 6 so demonstrations don't hang on pathological seeds. The cap is a config knob.
- **`MAX_LOG_ENTRIES = 500`.** Prevents unbounded log growth without adding virtualization. Real product would virtualize.
- **Strict TypeScript settings.** `noUncheckedIndexedAccess`, `noImplicitOverride`, etc. The cost is a few `!` non-null assertions in tight loops where we just checked the bound; the benefit is catching real bugs at the type layer.
- **`exactOptionalPropertyTypes: false`.** Turned this one *off* because the noise from `retryAfterMs?: number` patterns wasn't paying for itself. A deliberate downgrade, not an oversight.
- **No mocking in `Orchestrator.test.ts`.** The integration tests drive the real orchestrator with real simulators (just seeded). This catches integration bugs that single-class mocks would hide.

---

## 5. Tradeoffs

- **In-process simulators vs. SSE/fetch.** Picking in-process async iterators behind the `NodeClient` interface buys deterministic tests at the cost of not exercising real network parsing. The interface is the same, so this is a drop-in upgrade later.
- **rAF cadence.** 60Hz is the natural display rate. Coarser would reduce CPU; finer would cause render storms; 60Hz is the right default.
- **State machine as string literals.** Slightly less type-safe than a tagged union of objects, but renders in JSON / logs / DevTools without unwrapping. For an observability-heavy system this is the right tradeoff.
- **Failover within run, not across runs.** The orchestrator runs to completion or to `failed`; there's no notion of "automatically restart a failed stream." That belongs at a higher layer (a real product would expose a `retry()` and let the user / scheduler decide).

---

## 6. Testing strategy

Five categories of test, all in the same Vitest run:

1. **Pure-function tests** (`rng`, parts of `MetricsEngine`) — virtual clocks, no async.
2. **Unit tests** of single components (`FailoverManager`) — synthetic `NodeError`s, no real I/O.
3. **Contract tests** of the `NodeClient` implementation (`SimulatedStreamNode`) — strict-ordering invariants, abort handling, seed determinism.
4. **Integration tests** of the orchestrator with hand-rolled flaky nodes that exercise specific failure paths (forced drop, duplicate index, slow node + stop).
5. **Property-ish tests** that sweep multiple seeds and assert the corpus invariant on every successful run — catches whole-system bugs that a single fixed input would miss.

I did not write component-level React tests. They would be high-cost (jsdom + Testing Library + careful selector queries) and low-signal (the components are thin views over a thoroughly-tested store). The right thing to test is the orchestrator's correctness, which is exhaustively covered.

---

## 7. What I'd do next if I had another day

- **A real SSE/fetch `NodeClient`** behind a feature flag, so the demo can run against a hosted mock endpoint without changing orchestration code.
- **Web Worker isolation** for each node so a runaway iterator can't starve the main thread.
- **Virtualized event log** — at high failure rates the log can produce hundreds of entries; a `react-virtual` table would keep render cost flat.
- **Token-rate histogram** (p50/p95/p99 TPS) alongside the live TPS gauge — gives a much better signal than a single number under bursty conditions.
- **Failure-injection panel** — let the reviewer click a button to force a drop or 429 on a specific node, instead of relying on the simulator's RNG. This would make the failover behavior demonstrable without waiting for randomness.

---

## 8. Summary

AI handled the syntactic heavy lifting — boilerplate, type-driven scaffolding, test cases for fixed inputs. It did not handle:

- the choice of failover protocol,
- the decision to keep per-chunk events out of the store,
- the TTFT-set-once invariant,
- the early-window TPS divisor clamp,
- the per-attempt AbortController discipline,
- the duplicate-index rejection test.

Those came from engineering judgment about correctness, performance, and observability — applied as constraints on the AI output, not delegated to it.

---

## 9. Second-pass self-review findings (post-initial submission)

Running a cold read of every file after the first pass revealed five more issues. All fixed before final submission.

| # | Issue | Severity | Fix |
|---|---|---|---|
| 1 | `NodeHealth` mutated in place; same reference stored in Zustand — silent stale state | Critical | `reportChunk`/`reportFailure` now produce new objects (`{ ...h, ... }`) |
| 2 | `raceWithTimeout` placeholder `nodeId: 'node-a'` corrected post-facto in `toNodeError` | Significant | Threaded real `nodeId` into `raceWithTimeout` |
| 3 | `attempt` counter incremented on `sleepUntilNextCooldown` — burning attempts on waits | Significant | Sleep loops no longer count against `maxAttempts` |
| 4 | `connected` event labelled `ttftMs` but is per-attempt latency, not user-visible TTFT | Significant | Renamed to `nodeLatencyMs` in the event type |
| 5 | MetricsEngine docstring said "divide by `now - firstEventTs`"; code uses `startedAt` | Minor | Docstring updated to match implementation |
