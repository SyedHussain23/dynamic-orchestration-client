/**
 * Core domain types. Shared by every layer.
 *
 * Design rule: types here describe the *protocol* between layers (simulator ↔
 * orchestrator ↔ store ↔ ui). They never depend on React, Zustand, or DOM APIs
 * so that the orchestration core stays unit-testable in pure node.
 */
export class NodeError extends Error {
    nodeId;
    kind;
    retryAfterMs;
    constructor(nodeId, kind, 
    /** For 429 only — server-suggested cooldown. */
    retryAfterMs) {
        super(`[${nodeId}] ${kind}${retryAfterMs ? ` retry=${retryAfterMs}ms` : ''}`);
        this.nodeId = nodeId;
        this.kind = kind;
        this.retryAfterMs = retryAfterMs;
        this.name = 'NodeError';
    }
}
