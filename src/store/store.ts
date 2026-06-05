import { create } from 'zustand';
import {
  LogEntry,
  MetricsSnapshot,
  NodeHealth,
  NodeId,
  OrchestratorEvent,
  OrchestratorState,
  StreamChunk,
} from '@/core/types';

/**
 * Zustand store.
 *
 * The store deliberately holds *snapshot* state, not hot-path state:
 *
 *   • Per-chunk arrivals (potentially thousands per second) do NOT call
 *     `set()`. Instead the consumer (see `bindOrchestrator`) accumulates
 *     chunks into a ref buffer and flushes once per requestAnimationFrame.
 *
 *   • Metrics are sampled, not pushed: the same rAF tick reads
 *     `MetricsEngine.snapshot()` and writes the result to the store. This
 *     means the UI sees at most 60 metric updates/sec regardless of TPS.
 *
 * Slicing by domain (`stream`, `nodes`, `metrics`, `logs`) lets components
 * subscribe narrowly and avoid unrelated re-renders.
 */

export interface StreamSlice {
  text: string;
  state: OrchestratorState;
  activeNodeId: NodeId | null;
}

export interface NodesSlice {
  health: Record<NodeId, NodeHealth | undefined>;
}

export interface MetricsSlice {
  snapshot: MetricsSnapshot;
}

export interface LogSlice {
  entries: LogEntry[];
}

export interface RootState {
  stream: StreamSlice;
  nodes: NodesSlice;
  metrics: MetricsSlice;
  logs: LogSlice;

  // Actions (mutations) — only called by the orchestrator binding layer
  // and the UI control bar. UI components should NOT mutate state directly.
  _appendText: (text: string) => void;
  _setState: (s: OrchestratorState) => void;
  _setActiveNode: (id: NodeId | null) => void;
  _setNodeHealth: (id: NodeId, h: NodeHealth) => void;
  _setMetrics: (m: MetricsSnapshot) => void;
  _appendLog: (entry: LogEntry) => void;
  _reset: () => void;
}

const EMPTY_METRICS: MetricsSnapshot = {
  ttftMs: null,
  tpsRolling: 0,
  totalTokens: 0,
  elapsedMs: null,
};

const MAX_LOG_ENTRIES = 500;

export const useStore = create<RootState>((set) => ({
  stream: { text: '', state: 'idle', activeNodeId: null },
  nodes: { health: {} as Record<NodeId, NodeHealth | undefined> },
  metrics: { snapshot: EMPTY_METRICS },
  logs: { entries: [] },

  _appendText: (text) =>
    set((s) => ({
      stream: { ...s.stream, text: s.stream.text + text },
    })),

  _setState: (st) =>
    set((s) => ({ stream: { ...s.stream, state: st } })),

  _setActiveNode: (id) =>
    set((s) => ({ stream: { ...s.stream, activeNodeId: id } })),

  _setNodeHealth: (id, h) =>
    set((s) => ({ nodes: { health: { ...s.nodes.health, [id]: h } } })),

  _setMetrics: (m) => set({ metrics: { snapshot: m } }),

  _appendLog: (entry) =>
    set((s) => {
      const next = [...s.logs.entries, entry];
      if (next.length > MAX_LOG_ENTRIES) next.splice(0, next.length - MAX_LOG_ENTRIES);
      return { logs: { entries: next } };
    }),

  _reset: () =>
    set({
      stream: { text: '', state: 'idle', activeNodeId: null },
      nodes: { health: {} as Record<NodeId, NodeHealth | undefined> },
      metrics: { snapshot: EMPTY_METRICS },
      logs: { entries: [] },
    }),
}));

// ─── Selectors ──────────────────────────────────────────────────────────────

export const selectStreamText = (s: RootState) => s.stream.text;
export const selectStreamState = (s: RootState) => s.stream.state;
export const selectActiveNode = (s: RootState) => s.stream.activeNodeId;
export const selectMetrics = (s: RootState) => s.metrics.snapshot;
export const selectLogs = (s: RootState) => s.logs.entries;
export const selectNodeHealth = (s: RootState) => s.nodes.health;

// ─── Orchestrator binding ──────────────────────────────────────────────────

/**
 * Wire an Orchestrator's event stream into the store using rAF-coalesced
 * writes. Returns a disposer.
 *
 * This is the *only* place per-chunk events touch the store, and even then
 * via a ref buffer flushed at most once per frame.
 */
export interface OrchestratorBinding {
  pushChunk(chunk: StreamChunk): void;
  consumeEvent(e: OrchestratorEvent): void;
  start(): void;
  stop(): void;
}

export function createBinding(opts: {
  getMetrics: () => MetricsSnapshot;
}): OrchestratorBinding {
  const buffer: StreamChunk[] = [];
  let rafHandle: number | null = null;
  let stopped = false;
  let logId = 0;

  const flush = () => {
    rafHandle = null;
    if (buffer.length > 0) {
      // Concatenate once per frame — single set() call.
      let text = '';
      for (const c of buffer) text += (text.length ? ' ' : '') + c.text;
      buffer.length = 0;
      useStore.getState()._appendText(text + ' ');
    }
    // Sample metrics every frame regardless of buffer state.
    useStore.getState()._setMetrics(opts.getMetrics());

    if (!stopped) schedule();
  };

  const schedule = () => {
    if (rafHandle !== null) return;
    rafHandle =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(flush)
        : (setTimeout(flush, 16) as unknown as number);
  };

  return {
    pushChunk(chunk) {
      buffer.push(chunk);
      schedule();
    },
    consumeEvent(e) {
      const log = useStore.getState()._appendLog;
      switch (e.type) {
        case 'start':
          useStore.getState()._reset();
          log({ id: ++logId, t: performance.now(), level: 'info', message: 'stream start' });
          break;
        case 'connected':
          useStore.getState()._setActiveNode(e.nodeId);
          log({
            id: ++logId,
            t: performance.now(),
            level: 'info',
            message: `connected to ${e.nodeId} (node latency=${e.nodeLatencyMs.toFixed(1)}ms)`,
          });
          break;
        case 'node-error':
          log({
            id: ++logId,
            t: performance.now(),
            level: 'warn',
            message: `node-error ${e.nodeId} ${e.kind}`,
            data: e.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : undefined,
          });
          break;
        case 'failover':
          useStore.getState()._setActiveNode(e.to);
          log({
            id: ++logId,
            t: performance.now(),
            level: 'warn',
            message: `failover ${e.from} → ${e.to} @ idx=${e.resumeFrom} (${e.reason})`,
          });
          break;
        case 'state':
          useStore.getState()._setState(e.to);
          log({
            id: ++logId,
            t: performance.now(),
            level: 'info',
            message: `state ${e.from} → ${e.to}`,
          });
          break;
        case 'health':
          useStore.getState()._setNodeHealth(e.nodeId, e.health);
          break;
        case 'done':
          log({
            id: ++logId,
            t: performance.now(),
            level: 'info',
            message: `done on ${e.nodeId}`,
          });
          // Stream finished naturally — stop the rAF loop so it doesn't
          // run at 60Hz indefinitely after completion.
          stopped = true;
          break;
        case 'failed':
          log({
            id: ++logId,
            t: performance.now(),
            level: 'error',
            message: `failed: ${e.reason}`,
          });
          stopped = true;
          break;
      }
    },
    start() {
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      if (rafHandle !== null) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafHandle);
        else clearTimeout(rafHandle);
        rafHandle = null;
      }
      // Final synchronous flush so chunks that arrived between the last frame
      // and stop() aren't lost.
      flush();
    },
  };
}
