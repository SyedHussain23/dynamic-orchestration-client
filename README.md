# Dynamic Orchestration Client

A self-healing streaming client that routes work across three simulated nodes, survives mid-stream failure without dropping or duplicating tokens, and reports precise TTFT and rolling-window TPS metrics.

Built for the Dizzaract AI Product Builder assignment. The focus is on engineering judgment — explicit state machine, offset-based recovery protocol, hot-path data kept out of React state, deterministic and reproducible failure simulation, and a layered architecture that keeps streaming logic, failover logic, metrics, and rendering strictly separated.

**Live demo:** https://dizzaract-six.vercel.app

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # vitest run
npm run typecheck    # tsc --noEmit
npm run build        # production build → dist/
```

Deploy directly to Vercel — `vercel.json` is already configured for Vite static output.

---

## Architecture at a glance

```
┌────────────────────────────────────────────────────────────┐
│ UI Layer (React + Tailwind, src/ui/)                       │
│   ControlBar · StreamView · MetricsPanel · NodeStatus      │
│   · EventLog                                               │
│   → narrow Zustand selectors; no business logic            │
└─────────────────────────┬──────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────┐
│ State Layer (src/store/)                                   │
│   Zustand store · rAF-coalesced binding                    │
│   → hot-path chunks buffered in a closure, flushed @60Hz   │
└─────────────────────────┬──────────────────────────────────┘
                          │ OrchestratorEvent
┌─────────────────────────▼──────────────────────────────────┐
│ Orchestration Layer (src/core/)                            │
│   Orchestrator    — state machine, abort, ordering         │
│   FailoverManager — circuit breaker, health, ranking       │
│   MetricsEngine   — TTFT + sliding-window TPS              │
└─────────────────────────┬──────────────────────────────────┘
                          │ NodeClient interface
┌─────────────────────────▼──────────────────────────────────┐
│ Simulation Layer (src/sim/)                                │
│   SimulatedStreamNode × 3                                  │
│   → seeded RNG · 30% per-attempt fault rate                │
│   → drop · rate-limit (429) · latency-spike                │
└────────────────────────────────────────────────────────────┘
```

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design, state-machine spec, and tradeoff discussion.

---

## What this submission emphasizes

### 1. Stream resilience & failover (35%)

- **Offset-continuation protocol.** Every chunk carries a monotonic `index`. The orchestrator commits a chunk only if `index === lastCommittedIndex + 1`. On failover, the replacement node opens with `resumeFrom = lastCommittedIndex + 1`. Idempotence is a property of the protocol, not of text-level dedup heuristics.
- **Per-attempt AbortController.** Failover always aborts the in-flight stream before opening the next one — there is no path by which a "zombie" generator can deliver a late chunk into a fresh attempt.
- **Adaptive chunk-stall timeout.** Per-node rolling p95 latency (sliding window of 32 samples) drives the chunk-stall watchdog: `timeout = clamp(min, p95 × multiplier, max)`. Latency spikes are caught without killing slow-but-alive nodes prematurely.
- **Circuit breaker with exponential cooldown.** Two consecutive failures opens the circuit; cooldown doubles on repeat opens (capped). 429 responses honor server `retryAfterMs`.
- **Deterministic ranking.** Node selection sorts by `(circuit-state, consecutive-failures, p95-latency)` — reproducible from logs.

### 2. Architecture & state management (25%)

- **Dependency inversion at every layer boundary.** UI knows about Zustand; Zustand knows about events; Orchestrator knows only `NodeClient`. Swapping the simulator for a real SSE/fetch client touches *no* orchestration code.
- **Hot-path data outside the store.** Per-chunk arrivals go into a ring buffer in a closure. A `requestAnimationFrame` tick flushes accumulated text + a metrics snapshot in *one* `set()` call. Result: render rate is bounded at ~60Hz regardless of TPS.
- **Sliced store, narrow selectors.** `stream` / `nodes` / `metrics` / `logs` are independent. The `MetricsPanel` re-renders at 60Hz; the `StreamView` only re-renders when text changes; the `NodeStatusPanel` only when health changes.
- **Explicit state machine.** `idle → connecting → streaming → failing-over → streaming → done | failed`. Every transition is logged via a structured `OrchestratorEvent`, making the system observable and trivially testable.

### 3. Mathematical precision (20%)

- **TTFT** uses `performance.now()` captured at the *consumer-visible* start of the run (`MetricsEngine.markStart()`, called before any node opens) and at the *first committed chunk* (not the first network byte — what the user actually sees). It is recorded once and never reset on failover.
- **TPS** is a true rolling 1000ms sliding window backed by an event deque. On each `snapshot()`:
  - evict events older than `now − 1000ms`,
  - sum tokens of remaining events,
  - divide by `min(1000, now − oldest)` so early-stream values aren't artificially zero.
  - Cost: O(1) amortized per record, O(k) per read where k is events-in-window.
- See `MetricsEngine.test.ts` for window-correctness tests covering both steady-state and post-eviction conditions.

### 4. AI workflow documentation (20%)

See [`AI_WORKFLOW.md`](./AI_WORKFLOW.md).

---

## File layout

```
src/
├── core/
│   ├── types.ts              ← protocol types shared across layers
│   ├── rng.ts                ← seedable PRNG (mulberry32)
│   ├── MetricsEngine.ts      ← TTFT + rolling-window TPS
│   ├── FailoverManager.ts    ← circuit breaker + ranking
│   └── Orchestrator.ts       ← state machine, offset commit, abort
├── sim/
│   ├── corpus.ts             ← shared token corpus
│   └── SimulatedStreamNode.ts← NodeClient impl with seeded faults
├── store/
│   ├── store.ts              ← Zustand store + rAF binding
│   └── wiring.ts             ← composition root for the UI
├── ui/
│   ├── App.tsx
│   ├── ControlBar.tsx
│   ├── StreamView.tsx
│   ├── MetricsPanel.tsx
│   ├── NodeStatusPanel.tsx
│   └── EventLog.tsx
├── test/setup.ts
└── main.tsx
```

---

## Testing

```bash
npm test            # all unit + integration tests
npm run test:watch  # vitest watch mode
npm run test:coverage
```

Coverage targets:

| Suite | What it proves |
|---|---|
| `rng.test.ts` | Deterministic PRNG; calibrated `chance()` |
| `MetricsEngine.test.ts` | TTFT captured once; 1000ms window eviction; pre-start guard |
| `FailoverManager.test.ts` | Circuit transitions; 429 honored; ranking order |
| `SimulatedStreamNode.test.ts` | Strict ordering; abort handling; seed determinism; resume |
| `Orchestrator.test.ts` | Happy path; forced-drop failover with no duplicates / gaps; duplicate-index rejection from non-compliant node; stop() cleanup; multi-seed invariant sweep |

All randomized tests use seeded `mulberry32` — failures are reproducible.

---

## Deployment

```bash
npm run build         # → dist/
npx vercel --prod     # or push to a Vercel-linked repo
```

`vercel.json` declares the Vite framework preset, a SPA fallback rewrite, and the correct build/output directories.

---

## License

MIT — see [`LICENSE`](./LICENSE) if you add one for the public repo.
