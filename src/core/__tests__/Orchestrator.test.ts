import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../Orchestrator';
import { SimulatedStreamNode } from '@/sim/SimulatedStreamNode';
import { mulberry32 } from '../rng';
import { NodeClient, NodeError, NodeId, OrchestratorEvent, StreamChunk } from '../types';

const CORPUS = 'a b c d e f g h i j k l m n o'.split(' ');

function makeNodes(seeds: number[], faultProbability = 0): NodeClient[] {
  const ids: NodeId[] = ['node-a', 'node-b', 'node-c'];
  return ids.map(
    (id, i) =>
      new SimulatedStreamNode({
        id,
        corpus: CORPUS,
        meanChunkMs: 1,
        jitterMs: 0,
        faultProbability,
        rng: mulberry32(seeds[i] ?? i),
      }),
  );
}

interface RunCapture {
  chunks: StreamChunk[];
  events: OrchestratorEvent[];
  nodesUsed: Set<NodeId>;
  failovers: number;
  finalState: string;
}

function capturingOrchestrator(nodes: NodeClient[], cfg: Record<string, unknown> = {}) {
  const cap: RunCapture = {
    chunks: [],
    events: [],
    nodesUsed: new Set(),
    failovers: 0,
    finalState: '',
  };
  const o = new Orchestrator({
    nodes,
    maxAttempts: 20,
    minChunkTimeoutMs: 200,
    timeoutMultiplier: 4,
    maxChunkTimeoutMs: 1000,
    ...cfg,
    onEvent: (e) => {
      cap.events.push(e);
      if (e.type === 'chunk') {
        cap.chunks.push(e.chunk);
        cap.nodesUsed.add(e.nodeId);
      }
      if (e.type === 'failover') cap.failovers++;
      if (e.type === 'state') cap.finalState = e.to;
    },
  });
  return { o, cap };
}

describe('Orchestrator — happy path', () => {
  it('streams the full corpus in order from a healthy node', async () => {
    const nodes = makeNodes([1, 2, 3], 0);
    const { o, cap } = capturingOrchestrator(nodes);
    await o.run('x');
    expect(cap.chunks.map((c) => c.text)).toEqual(CORPUS);
    expect(cap.chunks.map((c) => c.index)).toEqual(CORPUS.map((_, i) => i));
    expect(cap.finalState).toBe('done');
  });
});

describe('Orchestrator — failover correctness', () => {
  it('on a forced drop, switches nodes and continues without duplicate or lost tokens', async () => {
    // Use a hand-rolled node that drops after 5 chunks, then real nodes after.
    let chunksBeforeDrop = 0;
    const flaky: NodeClient = {
      id: 'node-a' as const,
      async *stream({ resumeFrom, signal }) {
        for (let i = resumeFrom; i < CORPUS.length; i++) {
          if (signal.aborted) throw new NodeError('node-a', 'abort');
          await new Promise((r) => setTimeout(r, 1));
          if (chunksBeforeDrop >= 5) throw new NodeError('node-a', 'drop');
          chunksBeforeDrop++;
          yield { index: i, text: CORPUS[i]!, emittedAt: performance.now() };
        }
      },
    };
    const nodes = [flaky, ...makeNodes([10, 20]).slice(1)];
    const { o, cap } = capturingOrchestrator(nodes);
    await o.run('x');

    expect(cap.finalState).toBe('done');
    // Verify all tokens, in order, exactly once.
    expect(cap.chunks.map((c) => c.text)).toEqual(CORPUS);
    expect(cap.chunks.map((c) => c.index)).toEqual(CORPUS.map((_, i) => i));
    // At least one failover happened.
    expect(cap.failovers).toBeGreaterThanOrEqual(1);
    // More than one node contributed to the stream.
    expect(cap.nodesUsed.size).toBeGreaterThanOrEqual(2);
  });

  it('rejects a non-compliant node that yields a duplicate index', async () => {
    // Node that repeats index 2.
    const bad: NodeClient = {
      id: 'node-a',
      async *stream({ resumeFrom, signal }) {
        let yielded = 0;
        for (let i = resumeFrom; i < CORPUS.length; i++) {
          if (signal.aborted) throw new NodeError('node-a', 'abort');
          await new Promise((r) => setTimeout(r, 1));
          if (i === 3 && yielded === 3) {
            // Duplicate index 2 — orchestrator must reject.
            yield { index: 2, text: 'DUP', emittedAt: performance.now() };
          }
          yield { index: i, text: CORPUS[i]!, emittedAt: performance.now() };
          yielded++;
        }
      },
    };
    const nodes = [bad, ...makeNodes([100, 200]).slice(1)];
    const { o, cap } = capturingOrchestrator(nodes);
    await o.run('x');
    expect(cap.chunks.map((c) => c.text)).toEqual(CORPUS);
    expect(cap.chunks.find((c) => c.text === 'DUP')).toBeUndefined();
  });

  it('honors stop() and transitions cleanly', async () => {
    const slowNode: NodeClient = {
      id: 'node-a',
      async *stream({ signal }) {
        for (let i = 0; i < 100; i++) {
          if (signal.aborted) throw new NodeError('node-a', 'abort');
          await new Promise((r) => setTimeout(r, 50));
          yield { index: i, text: String(i), emittedAt: performance.now() };
        }
      },
    };
    const { o, cap } = capturingOrchestrator([slowNode, ...makeNodes([1, 2]).slice(1)]);
    const p = o.run('x');
    setTimeout(() => o.stop(), 60);
    await p;
    // Final state is failed or done; the key invariant is that we don't hang.
    expect(['failed', 'done']).toContain(cap.finalState);
  });
});

describe('Orchestrator — duplicate-token invariant under random faults', () => {
  it('over many seeds, every successful run yields the corpus in exact order', async () => {
    let runs = 0;
    let successes = 0;
    for (let seed = 0; seed < 12; seed++) {
      const nodes = makeNodes([seed, seed + 100, seed + 200], 0.5);
      const { o, cap } = capturingOrchestrator(nodes, {
        maxAttempts: 30,
        minChunkTimeoutMs: 50,
        maxChunkTimeoutMs: 400,
      });
      await o.run('x');
      runs++;
      if (cap.finalState === 'done') {
        successes++;
        // The CORE invariant: text matches corpus exactly, indices are 0..N-1.
        expect(cap.chunks.map((c) => c.text)).toEqual(CORPUS);
        expect(cap.chunks.map((c) => c.index)).toEqual(CORPUS.map((_, i) => i));
      }
    }
    // We should usually succeed at least once across 12 seeds.
    expect(successes).toBeGreaterThan(0);
    expect(runs).toBe(12);
  });
});
