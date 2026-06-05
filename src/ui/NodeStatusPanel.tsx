import { useStore } from '@/store/wiring';
import { selectNodeHealth, selectActiveNode } from '@/store/store';
import type { NodeHealth, NodeId } from '@/core/types';
import clsx from 'clsx';

const ALL_IDS: NodeId[] = ['node-a', 'node-b', 'node-c'];

export function NodeStatusPanel() {
  const health = useStore(selectNodeHealth);
  const active = useStore(selectActiveNode);

  return (
    <div className="rounded-lg bg-panel border border-slate-800 p-4">
      <h2 className="text-xs uppercase tracking-widest text-slate-400 mb-3">Nodes</h2>
      <div className="flex flex-col gap-2">
        {ALL_IDS.map((id) => (
          <NodeRow key={id} id={id} h={health[id]} active={active === id} />
        ))}
      </div>
    </div>
  );
}

function NodeRow({ id, h, active }: { id: NodeId; h: NodeHealth | undefined; active: boolean }) {
  const circuit = h?.circuit ?? 'closed';
  const dot =
    circuit === 'closed' ? 'bg-ok' :
    circuit === 'half-open' ? 'bg-warn' :
    'bg-bad';
  return (
    <div
      className={clsx(
        'rounded border px-3 py-2 flex items-center justify-between text-sm',
        active ? 'border-ok/60 bg-ok/5' : 'border-slate-800 bg-slate-900/40',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
        <span className="font-semibold">{id}</span>
        {active && <span className="text-[10px] text-ok uppercase tracking-widest">active</span>}
      </div>
      <div className="text-xs text-slate-400 flex gap-4 tabular-nums">
        <span>chunks <span className="text-slate-200">{h?.chunksDelivered ?? 0}</span></span>
        <span>p95 <span className="text-slate-200">{(h?.latencyP95Ms ?? 0).toFixed(0)}ms</span></span>
        <span>fails <span className="text-slate-200">{h?.consecutiveFailures ?? 0}</span></span>
        <span className="uppercase tracking-wider">{circuit}</span>
      </div>
    </div>
  );
}
