import { create } from 'zustand';
import { shallow } from 'zustand/shallow';
const EMPTY_METRICS = {
    ttftMs: null,
    tpsRolling: 0,
    totalTokens: 0,
    elapsedMs: null,
};
const MAX_LOG_ENTRIES = 500;
export const useStore = create((set) => ({
    stream: { text: '', tokensCommitted: 0, state: 'idle', activeNodeId: null },
    nodes: { health: {} },
    metrics: { snapshot: EMPTY_METRICS },
    logs: { entries: [] },
    _appendText: (text, tokens) => set((s) => ({
        stream: {
            ...s.stream,
            text: s.stream.text + text,
            tokensCommitted: s.stream.tokensCommitted + tokens,
        },
    })),
    _setState: (st) => set((s) => ({ stream: { ...s.stream, state: st } })),
    _setActiveNode: (id) => set((s) => ({ stream: { ...s.stream, activeNodeId: id } })),
    _setNodeHealth: (id, h) => set((s) => ({ nodes: { health: { ...s.nodes.health, [id]: h } } })),
    _setMetrics: (m) => set({ metrics: { snapshot: m } }),
    _appendLog: (entry) => set((s) => {
        const next = [...s.logs.entries, entry];
        if (next.length > MAX_LOG_ENTRIES)
            next.splice(0, next.length - MAX_LOG_ENTRIES);
        return { logs: { entries: next } };
    }),
    _reset: () => set({
        stream: { text: '', tokensCommitted: 0, state: 'idle', activeNodeId: null },
        nodes: { health: {} },
        metrics: { snapshot: EMPTY_METRICS },
        logs: { entries: [] },
    }),
}));
// ─── Selectors ──────────────────────────────────────────────────────────────
export const selectStreamText = (s) => s.stream.text;
export const selectStreamState = (s) => s.stream.state;
export const selectActiveNode = (s) => s.stream.activeNodeId;
export const selectMetrics = (s) => s.metrics.snapshot;
export const selectLogs = (s) => s.logs.entries;
export const selectNodeHealth = (s) => s.nodes.health;
export { shallow };
export function createBinding(opts) {
    const buffer = [];
    let rafHandle = null;
    let stopped = false;
    let logId = 0;
    const flush = () => {
        rafHandle = null;
        if (buffer.length > 0) {
            // Concatenate once per frame — single set() call.
            let text = '';
            for (const c of buffer)
                text += (text.length ? ' ' : '') + c.text;
            const tokens = buffer.length;
            buffer.length = 0;
            useStore.getState()._appendText(text + (tokens > 0 ? ' ' : ''), tokens);
        }
        // Sample metrics every frame regardless of buffer state.
        useStore.getState()._setMetrics(opts.getMetrics());
        if (!stopped)
            schedule();
    };
    const schedule = () => {
        if (rafHandle !== null)
            return;
        rafHandle =
            typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame(flush)
                : setTimeout(flush, 16);
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
                    break;
                case 'failed':
                    log({
                        id: ++logId,
                        t: performance.now(),
                        level: 'error',
                        message: `failed: ${e.reason}`,
                    });
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
                if (typeof cancelAnimationFrame === 'function')
                    cancelAnimationFrame(rafHandle);
                else
                    clearTimeout(rafHandle);
                rafHandle = null;
            }
            // Final synchronous flush so chunks that arrived between the last frame
            // and stop() aren't lost.
            flush();
        },
    };
}
