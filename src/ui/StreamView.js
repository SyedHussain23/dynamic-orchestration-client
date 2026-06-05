import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
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
    return (_jsxs("div", { className: "rounded-lg bg-panel border border-slate-800 p-4 min-h-[280px] flex flex-col", children: [_jsxs("div", { className: "flex items-center justify-between mb-2", children: [_jsx("h2", { className: "text-xs uppercase tracking-widest text-slate-400", children: "Stream output" }), _jsx("span", { className: "text-xs text-slate-500", children: active ? _jsxs(_Fragment, { children: ["active: ", _jsx("span", { className: "text-slate-200", children: active })] }) : 'no active node' })] }), _jsxs("pre", { className: "flex-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-100", children: [text || _jsx("span", { className: "text-slate-500", children: "\u2014 stream idle \u2014" }), text && _jsx("span", { className: "animate-pulse text-slate-400", children: "\u258D" })] })] }));
}
export const StreamView = memo(StreamViewImpl);
