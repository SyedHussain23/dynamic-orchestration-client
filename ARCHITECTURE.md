# Architecture

This document is the design half of the submission. It explains *why* the code looks the way it does — the alternatives considered, the invariants enforced, and the failure modes the architecture is hardened against.

---

## 1. Layered design and dependency direction

```
ui ──► store ──► orchestration ──► sim
```

Dependencies point *down*. No upward import is allowed:

- The orchestrator never imports React, Zustand, or DOM APIs (`performance` is the single exception, and it's injectable).
- The simulator never imports the orchestrator; it implements `NodeClient` and nothing more.
- UI components never import the orchestrator directly — they go through the store binding.

This is what lets us unit-test the orchestrator in plain Node (no jsdom, no React) and swap the simulator for a real SSE client by editing one file (`src/store/wiring.ts`).

---

## 2. The streaming protocol

A streamed token is:

```ts
interface StreamChunk {
  index: number;     // strictly monotonic, gap-free, starts at 0
  text: string;
  emittedAt: number; // performance.now() at emit
}
```

**Index is the load-bearing field.** It is the entire failover contract:

- The orchestrator commits a chunk *only* if `chunk.index === lastCommittedIndex + 1`.
- On failover, the orchestrator opens the new node with `resumeFrom = lastCommittedIndex + 1`.
- A compliant node cannot cause a duplicate or a gap.
- A non-compliant node (the orchestrator test suite includes one) surfaces a hard error rather than silently corrupting output.

### Why not text-level deduplication?

It's the obvious-but-wrong choice:

- Two nodes can legitimately emit the same word (the corpus contains "the" twice). A text-dedup heuristic can't distinguish a duplicate from a repeat.
- Failover that happens mid-token would either lose half a word or require fuzzy alignment.
- Correctness becomes a property of a heuristic rather than a property of the protocol.

Index-based commit is *exact* and verifiable in tests with simple equality assertions.

---

## 3. Orchestrator state machine

```
        ┌─────┐
        │idle │
        └──┬──┘
           │ start
           ▼
     ┌───────────┐                ┌────────┐
     │connecting │──── (none) ───►│ failed │
     └──────┬────┘                └────────┘
            │ first chunk
            ▼
     ┌────────────┐                  ┌──────┐
     │ streaming  │── chunks ───────►│ done │
     └──────┬─────┘  exhausted       └──────┘
            │ node-error
            ▼
   ┌─────────────────┐  next node      (back to streaming)
   │ failing-over    │── selected ──────────────────────┐
   └─────────────────┘                                  │
            │ none eligible                             │
            ▼                                           │
        ┌────────┐                                      │
        │ failed │ ◄────────────────────────────────────┘
        └────────┘
```

Every transition emits an `OrchestratorEvent` of type `state`, so the UI's event log and the test harness see the same state stream. There is no implicit state — no booleans named `isFailingOver` scattered through the code.

---

## 4. Failover policy

`FailoverManager` is purely bookkeeping; it does no I/O. The orchestrator drives it:

| Event | What happens |
|---|---|
| Chunk delivered | `reportChunk(nodeId, interChunkMs)` — closes half-open circuit, resets consecutive-failure count, updates rolling-p95 latency window. |
| Drop / timeout | `reportFailure(NodeError)` — bumps consecutive-failure count; if ≥ threshold (default 2), opens the circuit with current cooldown; doubles cooldown for next time (capped at `maxCooldownMs`). |
| 429 | Same as above but **immediately** opens the circuit and prefers `err.retryAfterMs` over the breaker cooldown. |
| Picking next | Filters out nodes whose circuit is `open` and whose cooldown has not elapsed; sorts the rest by `(circuit-state, consecutive-failures, p95-latency)`. If all nodes are open, the most-recently-failed node is allowed back in as a last resort so we don't deadlock. |

### Adaptive chunk-stall timeout

Per-node `latencyP95Ms` is computed over a 32-sample sliding window of inter-chunk gaps. The orchestrator races each `iter.next()` against:

```
timeout = clamp(minChunkTimeoutMs, latencyP95 × multiplier, maxChunkTimeoutMs)
```

This catches the simulator's `latency-spike` fault without aggressively killing slow-but-alive nodes. On timeout, the per-attempt `AbortController` aborts the underlying iterator (the simulator listens to the signal) and a `NodeError({kind: 'timeout'})` propagates through the normal failover path.

---

## 5. Metrics

### TTFT

```ts
markStart()                       // before any node opens
on first committed chunk:
  ttftMs = chunk.emittedAt - startedAt   // recorded once
```

Captured at the consumer-visible boundary, not at the network boundary. If the first node drops before yielding a token, TTFT is the time from `markStart()` to the first chunk of the *successful* attempt — which is exactly what the user perceived.

### TPS (rolling 1000ms)

```
events: Deque<{ t: number; tokens: number }>

on record(tokens, at):
  events.push({ t: at, tokens })

on snapshot():
  evict events with t < now - 1000ms
  windowTokens = Σ events.tokens
  span = min(1000, max(1, now - events[0].t))
  tps = windowTokens * 1000 / span
```

The `span` clamp is important: during the first second of streaming, dividing by 1000 underreports TPS by up to 2×. Dividing by `now - firstEvent` gives the right rate immediately, then naturally converges to `windowTokens / 1` once we've been running ≥ 1s.

Cost: O(1) amortized writes (push), O(k) reads where k is events-in-last-second. For a 200 tps stream that's ~200 elements — well under any concerning bound.

---

## 6. State management & render performance

Two principles:

### Principle A — the store does not see the hot path

Per-chunk events do not call `set()`. The orchestrator-to-store binding maintains a buffer in a closure. On each `requestAnimationFrame` tick:

1. concatenate buffered chunk texts → one append to the store,
2. read `MetricsEngine.snapshot()` → one write to the store,
3. schedule the next frame.

Result: at most ~60 store updates per second regardless of stream rate. Without this, a 200 tps stream would cause ~200 React re-renders per second of `StreamView`, freezing the UI.

### Principle B — components subscribe narrowly

| Component | Subscribes to |
|---|---|
| `StreamView` | `stream.text`, `stream.activeNodeId` only |
| `MetricsPanel` | `metrics.snapshot` only |
| `NodeStatusPanel` | `nodes.health`, `stream.activeNodeId` |
| `EventLog` | `logs.entries` |

A metrics tick at 60Hz does **not** re-render the stream view; a stream chunk does **not** re-render the metrics panel beyond its own frame.

---

## 7. Testing strategy

| Layer | Approach |
|---|---|
| `MetricsEngine` | Injected `now()` clock — virtual time, no `setTimeout`. Tests assert exact TTFT, exact TPS, and post-eviction behavior. |
| `FailoverManager` | Pure-function-style — drive with synthetic `NodeError`s, assert circuit transitions and ranking. |
| `SimulatedStreamNode` | Seeded RNG → identical seeds yield identical sequences. Abort tests use real timers but tiny intervals. |
| `Orchestrator` | Two flavors: (a) hand-rolled `NodeClient` implementations that simulate exact fault sequences (drop after N chunks, duplicate index), and (b) a multi-seed sweep with random faults that asserts the corpus invariant on every successful run. |

The duplicate-index test deserves callout — it proves the orchestrator's *strict ordering* contract is enforced even against a misbehaving node, not just trusted.

---

## 8. Tradeoffs & explicit non-goals

- **In-process simulators vs. real network.** The brief says "simulate." In-process async generators give us deterministic, fast, reproducible failure tests at the cost of not exercising real `ReadableStream` parsing. The `NodeClient` interface keeps the door open: a real-network implementation is a drop-in replacement.
- **No web workers.** Per-chunk work is microseconds. Putting nodes in workers would add a postMessage protocol surface to test and obscure the orchestration logic without measurable benefit at this token rate.
- **No retries inside a single attempt.** Retries happen at the *orchestrator* level by selecting a different node, not by reconnecting to the same one. This is simpler and matches the spec's "switch automatically" requirement.
- **rAF cadence (~60Hz).** Coarser flushing (e.g. 30Hz) would reduce CPU further; finer (e.g. per-chunk) would cause render storms. 60Hz is the natural display rate and matches what users perceive as smooth.
- **MAX_LOG_ENTRIES = 500.** Hardcap to prevent unbounded log growth in long-running streams. A real product would use a virtualized log; for an assignment that adds little signal.
