import { Orchestrator } from '@/core/Orchestrator';
import { SimulatedStreamNode } from '@/sim/SimulatedStreamNode';
import { CORPUS } from '@/sim/corpus';
import { mulberry32 } from '@/core/rng';
import { NodeId } from '@/core/types';
import { createBinding, useStore } from './store';

/**
 * Application wiring. This module is the single place that knows how the
 * pieces fit together. The UI imports `controller`; tests import the
 * factories directly.
 */

const NODE_IDS: NodeId[] = ['node-a', 'node-b', 'node-c'];

export interface AppController {
  start(prompt: string): void;
  stop(): void;
}

export function createController(opts: { seed?: number } = {}): AppController {
  const seed = opts.seed ?? Math.floor(Math.random() * 0xffffffff);
  // Each node gets its own derived seed for independence.
  const nodes = NODE_IDS.map(
    (id, i) =>
      new SimulatedStreamNode({
        id,
        corpus: CORPUS,
        meanChunkMs: 35 + i * 10, // node-a fastest, node-c slowest
        jitterMs: 15,
        faultProbability: 0.3,
        rng: mulberry32(seed + i * 7919),
      }),
  );

  let orchestrator: Orchestrator | null = null;
  let binding: ReturnType<typeof createBinding> | null = null;

  return {
    start(prompt: string) {
      // Tear down any prior run before starting fresh.
      orchestrator?.stop();
      binding?.stop();

      orchestrator = new Orchestrator({
        nodes,
        onEvent: (e) => {
          binding!.consumeEvent(e);
          if (e.type === 'chunk') binding!.pushChunk(e.chunk);
        },
      });
      binding = createBinding({
        getMetrics: () => orchestrator!.metrics.snapshot(),
      });
      binding.start();
      void orchestrator.run(prompt).catch(() => {
        // Errors are already surfaced via events; swallow to avoid unhandled rejection.
      });
    },
    stop() {
      orchestrator?.stop();
      binding?.stop();
    },
  };
}

/** A lazily-constructed singleton controller for the UI. */
let _ctrl: AppController | null = null;
export const getController = (): AppController => {
  if (!_ctrl) _ctrl = createController();
  return _ctrl;
};

// Re-export the store so UI components have one import path.
export { useStore };
