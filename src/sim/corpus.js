/**
 * Deterministic token corpus. Tokenized to mimic a real LLM stream
 * (one token ≈ one word or punctuation). All three simulated nodes share
 * this corpus — that's what makes offset-based failover meaningful: any node
 * is, logically, the "same" model.
 */
const TEXT = `The orchestration engine routes work across three streaming nodes and survives node failure mid-stream without dropping or duplicating any token. Each chunk carries a monotonic index, and on failover the replacement node resumes at the next index after the last committed token. This makes recovery idempotent by construction, rather than relying on text-level deduplication heuristics. The metrics layer computes time-to-first-token with high-resolution timestamps and a true rolling tokens-per-second over a 1000 millisecond sliding window using a constant-time event deque. The UI is kept off the hot path: chunks accumulate in a ring buffer and flush to React state on a request-animation-frame tick to avoid render storms. Failover policy combines a per-node circuit breaker, adaptive timeout based on rolling latency, and bounded exponential backoff with jitter for 429 responses. When all nodes are exhausted the orchestrator transitions to failed with a clear reason. This architecture cleanly separates simulation, orchestration, metrics, state, and rendering, so each layer can be unit tested in isolation.`;
export const CORPUS = TEXT.split(/\s+/).filter(Boolean);
