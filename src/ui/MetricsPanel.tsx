import { useStore } from '@/store/wiring';
import { selectMetrics } from '@/store/store';

export function MetricsPanel() {
  const m = useStore(selectMetrics);
  return (
    <div className="rounded-lg bg-panel border border-slate-800 p-4 grid grid-cols-4 gap-4">
      <Metric label="TTFT" value={m.ttftMs === null ? '—' : `${m.ttftMs.toFixed(1)} ms`} />
      <Metric label="TPS (1s)" value={m.tpsRolling.toFixed(1)} />
      <Metric label="Tokens" value={String(m.totalTokens)} />
      <Metric label="Elapsed" value={m.elapsedMs === null ? '—' : `${(m.elapsedMs / 1000).toFixed(2)} s`} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-widest text-slate-400">{label}</span>
      <span className="text-2xl tabular-nums">{value}</span>
    </div>
  );
}
