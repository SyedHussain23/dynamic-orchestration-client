import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useStore } from '@/store/wiring';
import { selectNodeHealth, selectActiveNode } from '@/store/store';
import clsx from 'clsx';
const ALL_IDS = ['node-a', 'node-b', 'node-c'];
export function NodeStatusPanel() {
    const health = useStore(selectNodeHealth);
    const active = useStore(selectActiveNode);
    return (_jsxs("div", { className: "rounded-lg bg-panel border border-slate-800 p-4", children: [_jsx("h2", { className: "text-xs uppercase tracking-widest text-slate-400 mb-3", children: "Nodes" }), _jsx("div", { className: "flex flex-col gap-2", children: ALL_IDS.map((id) => (_jsx(NodeRow, { id: id, h: health[id], active: active === id }, id))) })] }));
}
function NodeRow({ id, h, active }) {
    const circuit = h?.circuit ?? 'closed';
    const dot = circuit === 'closed' ? 'bg-ok' :
        circuit === 'half-open' ? 'bg-warn' :
            'bg-bad';
    return (_jsxs("div", { className: clsx('rounded border px-3 py-2 flex items-center justify-between text-sm', active ? 'border-ok/60 bg-ok/5' : 'border-slate-800 bg-slate-900/40'), children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: `inline-block w-2 h-2 rounded-full ${dot}` }), _jsx("span", { className: "font-semibold", children: id }), active && _jsx("span", { className: "text-[10px] text-ok uppercase tracking-widest", children: "active" })] }), _jsxs("div", { className: "text-xs text-slate-400 flex gap-4 tabular-nums", children: [_jsxs("span", { children: ["chunks ", _jsx("span", { className: "text-slate-200", children: h?.chunksDelivered ?? 0 })] }), _jsxs("span", { children: ["p95 ", _jsxs("span", { className: "text-slate-200", children: [(h?.latencyP95Ms ?? 0).toFixed(0), "ms"] })] }), _jsxs("span", { children: ["fails ", _jsx("span", { className: "text-slate-200", children: h?.consecutiveFailures ?? 0 })] }), _jsx("span", { className: "uppercase tracking-wider", children: circuit })] })] }));
}
