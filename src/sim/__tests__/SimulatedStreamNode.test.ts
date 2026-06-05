import { describe, expect, it } from 'vitest';
import { SimulatedStreamNode } from '../SimulatedStreamNode';
import { mulberry32 } from '@/core/rng';
import { NodeError, StreamChunk } from '@/core/types';

const CORPUS = ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'the', 'lazy', 'dog'];

function makeNode(opts: { seed: number; faultProbability?: number }) {
  return new SimulatedStreamNode({
    id: 'node-a',
    corpus: CORPUS,
    meanChunkMs: 1,
    jitterMs: 0,
    faultProbability: opts.faultProbability ?? 0,
    rng: mulberry32(opts.seed),
  });
}

async function collect(it: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('SimulatedStreamNode', () => {
  it('yields chunks with strictly increasing indices starting at resumeFrom', async () => {
    const n = makeNode({ seed: 1 });
    const ac = new AbortController();
    const chunks = await collect(n.stream({ resumeFrom: 3, signal: ac.signal }));
    expect(chunks.map((c) => c.index)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(chunks.map((c) => c.text)).toEqual(CORPUS.slice(3));
  });

  it('honors abort signals mid-stream', async () => {
    const n = makeNode({ seed: 2 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 2);
    await expect(collect(n.stream({ resumeFrom: 0, signal: ac.signal }))).rejects.toThrowError(NodeError);
  });

  it('throws a NodeError when a fault triggers (deterministic by seed)', async () => {
    // High fault probability + careful seed → guaranteed fault.
    let faulted = false;
    for (let seed = 0; seed < 20 && !faulted; seed++) {
      const n = makeNode({ seed, faultProbability: 1 });
      const ac = new AbortController();
      try {
        await collect(n.stream({ resumeFrom: 0, signal: ac.signal }));
      } catch (e) {
        expect(e).toBeInstanceOf(NodeError);
        faulted = true;
      }
    }
    expect(faulted).toBe(true);
  });

  it('rejects invalid resumeFrom values', async () => {
    const n = makeNode({ seed: 3 });
    const ac = new AbortController();
    await expect(collect(n.stream({ resumeFrom: -1, signal: ac.signal }))).rejects.toThrowError(
      RangeError,
    );
    await expect(
      collect(n.stream({ resumeFrom: CORPUS.length + 1, signal: ac.signal })),
    ).rejects.toThrowError(RangeError);
  });

  it('produces identical sequences for identical seeds', async () => {
    const a = makeNode({ seed: 99 });
    const b = makeNode({ seed: 99 });
    const ac = new AbortController();
    const [ra, rb] = await Promise.all([
      collect(a.stream({ resumeFrom: 0, signal: ac.signal })),
      collect(b.stream({ resumeFrom: 0, signal: ac.signal })),
    ]);
    expect(ra.map((c) => c.index)).toEqual(rb.map((c) => c.index));
    expect(ra.map((c) => c.text)).toEqual(rb.map((c) => c.text));
  });
});
