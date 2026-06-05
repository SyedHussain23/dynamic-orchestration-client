import { NodeError, NodeErrorKind, NodeHealth, NodeId } from './types';

/**
 * FailoverManager — health tracking, circuit breaker, and node selection.
 *
 * Policy:
 *
 *  • Each node has a circuit breaker. After `failureThreshold` consecutive
 *    failures it trips OPEN and is excluded from selection until `cooldownMs`
 *    elapses, at which point it becomes HALF-OPEN (eligible for one probe).
 *    A successful chunk delivery on a half-open circuit closes it; a failure
 *    re-opens it with doubled cooldown (capped).
 *
 *  • 429 responses honor the server's `retryAfterMs` if provided, else
 *    fall back to exponential backoff with full jitter.
 *
 *  • Selection ranks healthy nodes by `(circuit closed first) then (fewer
 *    consecutive failures) then (lower latencyP95)`. Deterministic given
 *    identical inputs — important for testability.
 *
 *  • The manager owns *only* health bookkeeping. It does not perform any
 *    I/O. The orchestrator drives it via report* methods.
 */

export interface FailoverConfig {
  failureThreshold: number;
  baseCooldownMs: number;
  maxCooldownMs: number;
  now: () => number;
}

const DEFAULTS: FailoverConfig = {
  failureThreshold: 2,
  baseCooldownMs: 800,
  maxCooldownMs: 8000,
  now: () => performance.now(),
};

export class FailoverManager {
  private readonly cfg: FailoverConfig;
  private readonly health: Map<NodeId, NodeHealth> = new Map();
  /** Per-node current cooldown duration; doubles on repeat opens. */
  private readonly cooldowns: Map<NodeId, number> = new Map();
  /** Per-node rolling latency samples (chunk-to-chunk ms). */
  private readonly latencyWindows: Map<NodeId, number[]> = new Map();
  private static readonly LATENCY_WINDOW = 32;

  constructor(nodeIds: readonly NodeId[], cfg: Partial<FailoverConfig> = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    for (const id of nodeIds) {
      this.health.set(id, freshHealth(id));
      this.cooldowns.set(id, this.cfg.baseCooldownMs);
      this.latencyWindows.set(id, []);
    }
  }

  getHealth(nodeId: NodeId): NodeHealth {
    return this.health.get(nodeId)!;
  }

  getAllHealth(): NodeHealth[] {
    return Array.from(this.health.values());
  }

  /**
   * Pick the next node to try. Returns null if no node is currently
   * eligible (all circuits open with active cooldown).
   *
   * `excludeRecent` should be the node that just failed so we don't
   * immediately re-pick it even if it appears tied.
   */
  pick(excludeRecent: NodeId | null): NodeId | null {
    const now = this.cfg.now();
    const candidates: NodeHealth[] = [];

    for (const [id, h] of this.health.entries()) {
      if (h.nodeId === excludeRecent) continue;
      if (h.circuit === 'open' && now < h.cooldownUntil) continue;
      // Open circuit whose cooldown has elapsed → promote to half-open so the
      // type and UI accurately reflect the probe state.
      if (h.circuit === 'open' && now >= h.cooldownUntil) {
        const promoted = { ...h, circuit: 'half-open' as const };
        this.health.set(id, promoted);
        candidates.push(promoted);
      } else {
        candidates.push(h);
      }
    }

    if (candidates.length === 0) {
      // Last resort: allow the excluded node back in if no one else is available.
      if (excludeRecent) {
        const h = this.health.get(excludeRecent)!;
        if (!(h.circuit === 'open' && now < h.cooldownUntil)) candidates.push(h);
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      // Closed > half-open > (forcibly probed) open.
      const cs = circuitScore(a) - circuitScore(b);
      if (cs !== 0) return cs;
      if (a.consecutiveFailures !== b.consecutiveFailures) {
        return a.consecutiveFailures - b.consecutiveFailures;
      }
      return a.latencyP95Ms - b.latencyP95Ms;
    });

    return candidates[0]!.nodeId;
  }

  /** Called on each successful chunk delivery from `nodeId`. */
  reportChunk(nodeId: NodeId, interChunkMs: number | null): void {
    const h = this.health.get(nodeId)!;

    if (interChunkMs !== null && interChunkMs >= 0) {
      const w = this.latencyWindows.get(nodeId)!;
      w.push(interChunkMs);
      if (w.length > FailoverManager.LATENCY_WINDOW) w.shift();
    }

    const updatedCircuit = h.circuit !== 'closed' ? 'closed' as const : h.circuit;
    if (updatedCircuit === 'closed' && h.circuit !== 'closed') {
      // Circuit just closed — reset cooldown duration to base.
      this.cooldowns.set(nodeId, this.cfg.baseCooldownMs);
    }

    // Replace with a new object so store equality checks work correctly.
    this.health.set(nodeId, {
      ...h,
      chunksDelivered: h.chunksDelivered + 1,
      consecutiveFailures: 0,
      circuit: updatedCircuit,
      cooldownUntil: updatedCircuit === 'closed' ? 0 : h.cooldownUntil,
      latencyP95Ms:
        interChunkMs !== null && interChunkMs >= 0
          ? percentile(this.latencyWindows.get(nodeId)!, 0.95)
          : h.latencyP95Ms,
    });
  }

  /**
   * Called when a node fails. Returns the suggested cooldown (for 429s, the
   * server hint takes priority; otherwise breaker cooldown applies).
   */
  reportFailure(err: NodeError): { cooldownMs: number } {
    const h = this.health.get(err.nodeId)!;
    const consecutiveFailures = h.consecutiveFailures + 1;
    const failures = { ...h.failures, [err.kind]: (h.failures[err.kind] ?? 0) + 1 };

    const baseCooldown =
      err.kind === 'rate-limit' && typeof err.retryAfterMs === 'number'
        ? err.retryAfterMs
        : this.cooldowns.get(err.nodeId)!;

    let circuit = h.circuit;
    let cooldownUntil = h.cooldownUntil;

    if (consecutiveFailures >= this.cfg.failureThreshold) {
      circuit = 'open';
      cooldownUntil = this.cfg.now() + baseCooldown;
      this.cooldowns.set(
        err.nodeId,
        Math.min(this.cfg.maxCooldownMs, baseCooldown * 2),
      );
    } else if (err.kind === 'rate-limit') {
      circuit = 'open';
      cooldownUntil = this.cfg.now() + baseCooldown;
    }

    // Replace with a new object — never mutate the stored health reference.
    this.health.set(err.nodeId, { ...h, consecutiveFailures, failures, circuit, cooldownUntil });

    return { cooldownMs: baseCooldown };
  }

  reset(): void {
    for (const id of this.health.keys()) {
      this.health.set(id, freshHealth(id));
      this.cooldowns.set(id, this.cfg.baseCooldownMs);
      this.latencyWindows.set(id, []);
    }
  }
}

function freshHealth(nodeId: NodeId): NodeHealth {
  return {
    nodeId,
    circuit: 'closed',
    consecutiveFailures: 0,
    cooldownUntil: 0,
    latencyP95Ms: 0,
    chunksDelivered: 0,
    failures: { drop: 0, 'rate-limit': 0, timeout: 0, abort: 0 } as Record<
      NodeErrorKind,
      number
    >,
  };
}

function circuitScore(h: NodeHealth): number {
  if (h.circuit === 'closed') return 0;
  if (h.circuit === 'half-open') return 1;
  return 2;
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}
