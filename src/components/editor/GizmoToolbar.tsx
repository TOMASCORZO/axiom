'use client';

import { useEffect, useCallback } from 'react';
import { Move3D, RotateCw, Scale3D, MousePointer } from 'lucide-react';
import { useEditorStore } from '@/lib/store';
import { engineBridge } from '@/lib/engine/bridge';
import type { GizmoMode } from '@/types/engine';

interface ToolButton {
    mode: GizmoMode;
    icon: React.ElementType;
    label: string;
    hotkey: string;
}

const TOOLS: ToolButton[] = [
    { mode: 'none', icon: MousePointer, label: 'Select', hotkey: 'Q' },
    { mode: 'translate', icon: Move3D, label: 'Translate', hotkey: 'W' },
    { mode: 'rotate', icon: RotateCw, label: 'Rotate', hotkey: 'E' },
    { mode: 'scale', icon: Scale3D, label: 'Scale', hotkey: 'R' },
];

const HOTKEY_MAP: Record<string, GizmoMode> = {
    q: 'none',
    w: 'translate',
    e: 'rotate',
    r: 'scale',
};

/** Floating tool palette over the 3D viewport. Only meaningful when a node is selected. */
export default function GizmoToolbar() {
    const gizmoMode = useEditorStore((s) => s.gizmoMode);
    const setGizmoMode = useEditorStore((s) => s.setGizmoMode);
    const selectedNodePath = useEditorStore((s) => s.selectedNodePath);

    const apply = useCallback(
        (mode: GizmoMode) => {
            setGizmoMode(mode);
            engineBridge.setGizmoMode(mode);
        },
        [setGizmoMode],
    );

    // Re-push the gizmo mode whenever selection changes so the engine knows
    // to (re)build handles around the new target.
    useEffect(() => {
        if (selectedNodePath) {
            engineBridge.setGizmoMode(gizmoMode);
        }
    }, [selectedNodePath, gizmoMode]);

    // Hotkeys — skip when the user is typing into an input/textarea/contenteditable.
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            const target = e.target as HTMLElement | null;
            if (target) {
                const tag = target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
            }
            const next = HOTKEY_MAP[e.key.toLowerCase()];
            if (next) {
                apply(next);
                e.preventDefault();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [apply]);

    if (!selectedNodePath) return null;

    return (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-0.5 bg-zinc-950/90 backdrop-blur-sm border border-white/10 rounded-md p-1 shadow-lg">
            {TOOLS.map((tool) => {
                const active = tool.mode === gizmoMode;
                const Icon = tool.icon;
                return (
                    <button
                        key={tool.mode}
                        onClick={() => apply(tool.mode)}
                        title={`${tool.label} (${tool.hotkey})`}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${
                            active
                                ? 'bg-violet-500/30 text-violet-200'
                                : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                        }`}
                    >
                        <Icon size={13} />
                        <span className="font-mono text-[9px] opacity-60">{tool.hotkey}</span>
                    </button>
                );
            })}
        </div>
    );
}
