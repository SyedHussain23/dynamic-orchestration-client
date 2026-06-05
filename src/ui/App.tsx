import { ControlBar } from './ControlBar';
import { NodeStatusPanel } from './NodeStatusPanel';
import { StreamView } from './StreamView';
import { MetricsPanel } from './MetricsPanel';
import { EventLog } from './EventLog';

/**
 * Top-level layout. Components subscribe individually via narrow selectors,
 * so e.g. metrics ticks at 60Hz don't re-render the stream view.
 */
export default function App() {
  return (
    <div className="min-h-screen bg-ink text-slate-100 font-mono">
      <header className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div>
          <div className="text-xs text-slate-400 uppercase tracking-widest">
            Dynamic Orchestration Client
          </div>
          <h1 className="text-lg font-semibold">
            Self-healing streaming with offset-continuation failover
          </h1>
        </div>
        <a
          href="https://github.com/SyedHussain23/dynamic-orchestration-client"
          className="text-xs text-slate-400 hover:text-slate-200"
          target="_blank"
          rel="noreferrer"
        >
          source
        </a>
      </header>

      <main className="grid grid-cols-12 gap-4 p-4">
        <div className="col-span-12">
          <ControlBar />
        </div>

        <section className="col-span-12 lg:col-span-8 flex flex-col gap-4">
          <MetricsPanel />
          <StreamView />
        </section>

        <aside className="col-span-12 lg:col-span-4 flex flex-col gap-4">
          <NodeStatusPanel />
          <EventLog />
        </aside>
      </main>
    </div>
  );
}
