import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { getController, useStore } from '@/store/wiring';
import { selectStreamState } from '@/store/store';
export function ControlBar() {
    const state = useStore(selectStreamState);
    const [prompt, setPrompt] = useState('Tell me about resilient streaming.');
    const running = state === 'streaming' || state === 'connecting' || state === 'failing-over';
    return (_jsxs("div", { className: "rounded-lg bg-panel border border-slate-800 p-4 flex items-center gap-3", children: [_jsx("input", { className: "flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring focus:ring-blue-500/30", value: prompt, onChange: (e) => setPrompt(e.target.value), placeholder: "prompt\u2026", "aria-label": "prompt" }), running ? (_jsx("button", { className: "px-4 py-2 rounded bg-bad/90 hover:bg-bad text-white text-sm", onClick: () => getController().stop(), children: "Stop" })) : (_jsx("button", { className: "px-4 py-2 rounded bg-ok/90 hover:bg-ok text-white text-sm", onClick: () => getController().start(prompt), children: "Start stream" })), _jsx(StateBadge, { state: state })] }));
}
function StateBadge({ state }) {
    const color = state === 'streaming' ? 'bg-ok/20 text-ok' :
        state === 'failing-over' ? 'bg-warn/20 text-warn' :
            state === 'failed' ? 'bg-bad/20 text-bad' :
                state === 'done' ? 'bg-slate-700/30 text-slate-300' :
                    'bg-slate-800/60 text-slate-400';
    return (_jsx("span", { className: `text-xs px-2 py-1 rounded ${color} uppercase tracking-wider`, children: state }));
}
