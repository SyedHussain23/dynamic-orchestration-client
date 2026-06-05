import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useStore } from '@/store/wiring';
import { selectMetrics } from '@/store/store';
export function MetricsPanel() {
    const m = useStore(selectMetrics);
    return (_jsxs("div", { className: "rounded-lg bg-panel border border-slate-800 p-4 grid grid-cols-4 gap-4", children: [_jsx(Metric, { label: "TTFT", value: m.ttftMs === null ? '—' : `${m.ttftMs.toFixed(1)} ms` }), _jsx(Metric, { label: "TPS (1s)", value: m.tpsRolling.toFixed(1) }), _jsx(Metric, { label: "Tokens", value: String(m.totalTokens) }), _jsx(Metric, { label: "Elapsed", value: m.elapsedMs === null ? '—' : `${(m.elapsedMs / 1000).toFixed(2)} s` })] }));
}
function Metric({ label, value }) {
    return (_jsxs("div", { className: "flex flex-col", children: [_jsx("span", { className: "text-[10px] uppercase tracking-widest text-slate-400", children: label }), _jsx("span", { className: "text-2xl tabular-nums", children: value })] }));
}
