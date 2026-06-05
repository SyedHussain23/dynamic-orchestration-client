/**
 * Core domain types. Shared by every layer.
 *
 * Design rule: types here describe the *protocol* between layers (simulator ↔
 * orchestrator ↔ store ↔ ui). They never depend on React, Zustand, or DOM APIs
 * so that the orchestration core stays unit-testable in pure node.
 */

// ─── Streaming protocol ─────────────────────────────────────────────────────

/**
 * A single streamed token. `index` is the canonical position in the *logical*
 * output stream — it is what makes failover idempotent. Every node honors the
 * same index sequence for the same request; on failover the new node resumes
 * at `resumeFrom = lastCommittedIndex + 1`.
 */
export interface StreamChunk {
  /** Monotonic, gap-free position in the logical stream. Starts at 0. */
  index: number;
  /** Raw text for this token. */
  text: string;
  /** High-resolution timestamp captured at emit time (ms since timeOrigin). */
  emittedAt: number;
}

export type NodeId = 'node-a' | 'node-b' | 'node-c';

// ─── Failure modes (simulator) ──────────────────────────────────────────────

export type SimulatedFault =
  | { kind: 'drop' } // connection dies mid-stream
  | { kind: 'rate-limit'; retryAfterMs: number } // HTTP 429 analogue
  | { kind: 'latency-spike'; extraMs: number }; // long stall between chunks

// ─── NodeClient interface (protocol boundary) ──────────────────────────────

/**
 * Anything that can stream chunks. The orchestrator depends only on this
 * interface — never on the concrete simulator — so we can later swap in a real
 * SSE/fetch client without touching orchestration.
 */
export interface NodeClient {
  readonly id: NodeId;
  /**
   * Open a stream that begins at `resumeFrom`. Returns an async iterator of
   * chunks and a way to abort. Implementations MUST:
   *   1. Yield chunks with strictly increasing `index` starting at `resumeFrom`.
   *   2. Stop yielding immediately when the AbortSignal fires.
   *   3. Throw `NodeError` on failure (drop / 429 / timeout).
   */
  stream(args: { resumeFrom: number; signal: AbortSignal }): AsyncIterable<StreamChunk>;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export type NodeErrorKind = 'drop' | 'rate-limit' | 'timeout' | 'abort';

export class NodeError extends Error {
  constructor(
    public readonly nodeId: NodeId,
    public readonly kind: NodeErrorKind,
    /** For 429 only — server-suggested cooldown. */
    public readonly retryAfterMs?: number,
  ) {
    super(`[${nodeId}] ${kind}${retryAfterMs ? ` retry=${retryAfterMs}ms` : ''}`);
    this.name = 'NodeError';
  }
}

// ─── Orchestrator state machine ─────────────────────────────────────────────

/**
 * Explicit, enumerable states. Every transition is logged. Keeping this a
 * union of string literals (not a class field) makes the state visible in
 * the store and trivially renderable / testable.
 */
export type OrchestratorState =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'failing-over'
  | 'done'
  | 'failed';

export type OrchestratorEvent =
  | { type: 'start'; prompt: string }
  /** `nodeLatencyMs` is the time from this *attempt* opening to the first chunk
   *  from this node — not user-visible TTFT (which MetricsEngine owns). */
  | { type: 'connected'; nodeId: NodeId; nodeLatencyMs: number }
  | { type: 'chunk'; chunk: StreamChunk; nodeId: NodeId }
  | { type: 'node-error'; nodeId: NodeId; kind: NodeErrorKind; retryAfterMs?: number }
  | { type: 'failover'; from: NodeId; to: NodeId; resumeFrom: number; reason: string }
  | { type: 'done'; nodeId: NodeId }
  | { type: 'failed'; reason: string }
  | { type: 'state'; from: OrchestratorState; to: OrchestratorState }
  | { type: 'health'; nodeId: NodeId; health: NodeHealth };

// ─── Health / circuit-breaker ───────────────────────────────────────────────

export interface NodeHealth {
  nodeId: NodeId;
  /** 'closed' = healthy, 'open' = excluded, 'half-open' = on probation. */
  circuit: 'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
  /** Wall-clock ms until the open circuit may attempt half-open probe. */
  cooldownUntil: number;
  /** Rolling latency p95 (ms between chunks) — drives timeout adaptation. */
  latencyP95Ms: number;
  /** Total chunks this node has emitted across all attempts. */
  chunksDelivered: number;
  /** Failure counts by kind. */
  failures: Record<NodeErrorKind, number>;
}

// ─── Metrics ────────────────────────────────────────────────────────────────

export interface MetricsSnapshot {
  /** ms between request start and first chunk of the *entire* logical stream. */
  ttftMs: number | null;
  /** Tokens per second over the trailing 1000ms window. */
  tpsRolling: number;
  /** Cumulative tokens emitted to the UI. */
  totalTokens: number;
  /** Wall-clock ms since `start` was called. null if idle. */
  elapsedMs: number | null;
}

// ─── Log entries ────────────────────────────────────────────────────────────

export interface LogEntry {
  id: number;
  t: number; // performance.now()
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
}
