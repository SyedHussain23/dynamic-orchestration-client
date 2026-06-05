import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
    return (_jsxs("div", { className: "min-h-screen bg-ink text-slate-100 font-mono", children: [_jsxs("header", { className: "border-b border-slate-800 px-6 py-4 flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("div", { className: "text-xs text-slate-400 uppercase tracking-widest", children: "Dynamic Orchestration Client" }), _jsx("h1", { className: "text-lg font-semibold", children: "Self-healing streaming with offset-continuation failover" })] }), _jsx("a", { href: "https://github.com/", className: "text-xs text-slate-400 hover:text-slate-200", target: "_blank", rel: "noreferrer", children: "source" })] }), _jsxs("main", { className: "grid grid-cols-12 gap-4 p-4", children: [_jsx("div", { className: "col-span-12", children: _jsx(ControlBar, {}) }), _jsxs("section", { className: "col-span-12 lg:col-span-8 flex flex-col gap-4", children: [_jsx(MetricsPanel, {}), _jsx(StreamView, {})] }), _jsxs("aside", { className: "col-span-12 lg:col-span-4 flex flex-col gap-4", children: [_jsx(NodeStatusPanel, {}), _jsx(EventLog, {})] })] })] }));
}
