import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useStore } from '@/store/wiring';
import { selectLogs } from '@/store/store';
import clsx from 'clsx';
export function EventLog() {
    const entries = useStore(selectLogs);
    // Newest first for readability.
    const rows = [...entries].reverse().slice(0, 200);
    return (_jsxs("div", { className: "rounded-lg bg-panel border border-slate-800 p-4 flex-1 min-h-[280px] flex flex-col", children: [_jsx("h2", { className: "text-xs uppercase tracking-widest text-slate-400 mb-3", children: "Event log" }), _jsxs("div", { className: "flex-1 overflow-auto text-xs leading-relaxed", children: [rows.length === 0 && _jsx("div", { className: "text-slate-500", children: "\u2014 no events yet \u2014" }), rows.map((e) => (_jsxs("div", { className: clsx('py-0.5 border-b border-slate-900 last:border-b-0', e.level === 'error' && 'text-bad', e.level === 'warn' && 'text-warn', e.level === 'info' && 'text-slate-300'), children: [_jsxs("span", { className: "text-slate-500 tabular-nums", children: [(e.t / 1000).toFixed(3), "s"] }), ' ', e.message, e.data ? (_jsxs("span", { className: "text-slate-500", children: [" ", JSON.stringify(e.data)] })) : null] }, e.id)))] })] }));
}
