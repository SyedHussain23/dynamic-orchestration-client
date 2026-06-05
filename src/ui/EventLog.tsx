import { useStore } from '@/store/wiring';
import { selectLogs } from '@/store/store';
import clsx from 'clsx';

export function EventLog() {
  const entries = useStore(selectLogs);
  // Newest first for readability.
  const rows = [...entries].reverse().slice(0, 200);

  return (
    <div className="rounded-lg bg-panel border border-slate-800 p-4 flex-1 min-h-[280px] flex flex-col">
      <h2 className="text-xs uppercase tracking-widest text-slate-400 mb-3">Event log</h2>
      <div className="flex-1 overflow-auto text-xs leading-relaxed">
        {rows.length === 0 && <div className="text-slate-500">— no events yet —</div>}
        {rows.map((e) => (
          <div
            key={e.id}
            className={clsx(
              'py-0.5 border-b border-slate-900 last:border-b-0',
              e.level === 'error' && 'text-bad',
              e.level === 'warn' && 'text-warn',
              e.level === 'info' && 'text-slate-300',
            )}
          >
            <span className="text-slate-500 tabular-nums">
              {(e.t / 1000).toFixed(3)}s
            </span>{' '}
            {e.message}
            {e.data ? (
              <span className="text-slate-500"> {JSON.stringify(e.data)}</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
