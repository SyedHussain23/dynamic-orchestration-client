import { memo } from 'react';
import { useStore } from '@/store/wiring';
import { selectStreamText, selectActiveNode } from '@/store/store';

/**
 * Stream output. Subscribes only to `text` and `activeNodeId` so metric
 * ticks (60Hz) don't re-render this potentially-large block of text.
 */
function StreamViewImpl() {
  const text = useStore(selectStreamText);
  const active = useStore(selectActiveNode);

  return (
    <div className="rounded-lg bg-panel border border-slate-800 p-4 min-h-[280px] flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs uppercase tracking-widest text-slate-400">Stream output</h2>
        <span className="text-xs text-slate-500">
          {active ? <>active: <span className="text-slate-200">{active}</span></> : 'no active node'}
        </span>
      </div>
      <pre className="flex-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-100">
        {text || <span className="text-slate-500">— stream idle —</span>}
        {text && <span className="animate-pulse text-slate-400">▍</span>}
      </pre>
    </div>
  );
}

export const StreamView = memo(StreamViewImpl);
