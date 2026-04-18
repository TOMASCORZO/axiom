'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Box,
    FileCode2,
    RefreshCw,
    X,
    AlertCircle,
    Sliders,
} from 'lucide-react';
import { engineBridge } from '@/lib/engine/bridge';
import type { NodeInspectorData, NodeProperty } from '@/types/engine';
import { useEditorStore } from '@/lib/store';

// ── Value utilities ──────────────────────────────────────────────────

function asNumber(v: unknown): number {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
    return Number.isFinite(n) ? n : 0;
}

function asVector(v: unknown, size: 2 | 3 | 4): number[] {
    if (Array.isArray(v)) {
        return Array.from({ length: size }, (_, i) => asNumber(v[i]));
    }
    if (v && typeof v === 'object') {
        const obj = v as Record<string, unknown>;
        const keys = ['x', 'y', 'z', 'w'];
        return keys.slice(0, size).map((k) => asNumber(obj[k]));
    }
    return Array.from({ length: size }, () => 0);
}

function asColor(v: unknown): { r: number; g: number; b: number; a: number } {
    if (Array.isArray(v)) {
        return {
            r: asNumber(v[0]),
            g: asNumber(v[1]),
            b: asNumber(v[2]),
            a: v.length > 3 ? asNumber(v[3]) : 1,
        };
    }
    if (v && typeof v === 'object') {
        const obj = v as Record<string, unknown>;
        return {
            r: asNumber(obj.r),
            g: asNumber(obj.g),
            b: asNumber(obj.b),
            a: obj.a != null ? asNumber(obj.a) : 1,
        };
    }
    return { r: 1, g: 1, b: 1, a: 1 };
}

function colorToHex(c: { r: number; g: number; b: number }): string {
    const to = (n: number) => {
        const clamped = Math.max(0, Math.min(1, n));
        return Math.round(clamped * 255).toString(16).padStart(2, '0');
    };
    return `#${to(c.r)}${to(c.g)}${to(c.b)}`;
}

function hexToColor(hex: string, alpha: number): [number, number, number, number] {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return [1, 1, 1, alpha];
    return [
        parseInt(m[1], 16) / 255,
        parseInt(m[2], 16) / 255,
        parseInt(m[3], 16) / 255,
        alpha,
    ];
}

// ── Property editors ─────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="grid grid-cols-[110px_1fr] gap-2 items-center px-3 py-1.5 text-[11px]">
            <label className="text-zinc-500 truncate" title={label}>{label}</label>
            <div className="min-w-0">{children}</div>
        </div>
    );
}

function textInputClass(extra = '') {
    return `w-full bg-zinc-900/60 border border-white/[0.05] rounded px-1.5 py-1 text-[11px] text-zinc-200 focus:outline-none focus:border-violet-500/40 ${extra}`;
}

function NumberEditor({
    value,
    onCommit,
    step = 0.01,
}: {
    value: number;
    onCommit: (n: number) => void;
    step?: number;
}) {
    const [local, setLocal] = useState(String(value));
    const [lastValue, setLastValue] = useState(value);

    // React 19 derived-state pattern: reset local state in-render when the
    // prop changes from the outside (e.g. engine updated the value).
    if (value !== lastValue) {
        setLastValue(value);
        setLocal(String(value));
    }

    const commit = () => {
        const n = parseFloat(local);
        if (Number.isFinite(n) && n !== value) {
            onCommit(n);
        } else {
            setLocal(String(value));
        }
    };

    return (
        <input
            type="number"
            step={step}
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setLocal(String(value));
            }}
            className={textInputClass('font-mono')}
        />
    );
}

function VectorEditor({
    value,
    size,
    onCommit,
}: {
    value: number[];
    size: 2 | 3 | 4;
    onCommit: (v: number[]) => void;
}) {
    const axes = ['X', 'Y', 'Z', 'W'];
    return (
        <div className={`grid gap-1 ${size === 2 ? 'grid-cols-2' : size === 3 ? 'grid-cols-3' : 'grid-cols-4'}`}>
            {Array.from({ length: size }, (_, i) => (
                <div key={i} className="relative">
                    <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[9px] font-mono text-zinc-600 pointer-events-none">
                        {axes[i]}
                    </span>
                    <NumberEditor
                        value={value[i] ?? 0}
                        onCommit={(n) => {
                            const next = [...value];
                            next[i] = n;
                            onCommit(next);
                        }}
                    />
                </div>
            ))}
        </div>
    );
}

function BoolEditor({ value, onCommit }: { value: boolean; onCommit: (b: boolean) => void }) {
    return (
        <button
            onClick={() => onCommit(!value)}
            className={`w-8 h-4 rounded-full transition-colors relative ${value ? 'bg-violet-500/70' : 'bg-zinc-700'}`}
        >
            <span
                className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${value ? 'left-4' : 'left-0.5'}`}
            />
        </button>
    );
}

function StringEditor({
    value,
    multiline,
    onCommit,
}: {
    value: string;
    multiline?: boolean;
    onCommit: (s: string) => void;
}) {
    const [local, setLocal] = useState(value);
    const [lastValue, setLastValue] = useState(value);

    if (value !== lastValue) {
        setLastValue(value);
        setLocal(value);
    }

    const commit = () => {
        if (local !== value) {
            onCommit(local);
        }
    };

    if (multiline) {
        return (
            <textarea
                value={local}
                onChange={(e) => setLocal(e.target.value)}
                onBlur={commit}
                rows={3}
                className={textInputClass('font-mono resize-y')}
            />
        );
    }

    return (
        <input
            type="text"
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setLocal(value);
            }}
            className={textInputClass()}
        />
    );
}

function ColorEditor({
    value,
    noAlpha,
    onCommit,
}: {
    value: { r: number; g: number; b: number; a: number };
    noAlpha?: boolean;
    onCommit: (rgba: [number, number, number, number]) => void;
}) {
    const hex = colorToHex(value);
    return (
        <div className="flex items-center gap-1.5">
            <input
                type="color"
                value={hex}
                onChange={(e) => onCommit(hexToColor(e.target.value, value.a))}
                className="w-7 h-6 bg-transparent border border-white/10 rounded cursor-pointer"
            />
            <span className="text-[10px] font-mono text-zinc-500 flex-1 truncate">{hex.toUpperCase()}</span>
            {!noAlpha && (
                <div className="w-10">
                    <NumberEditor
                        value={value.a}
                        step={0.01}
                        onCommit={(a) => onCommit([value.r, value.g, value.b, a])}
                    />
                </div>
            )}
        </div>
    );
}

function EnumEditor({
    value,
    hintString,
    onCommit,
}: {
    value: unknown;
    hintString?: string;
    onCommit: (v: number) => void;
}) {
    const options = useMemo(() => {
        if (!hintString) return [];
        // Godot enum hint strings: "Name:0,Name:1" or "Name,Name" (indices implicit)
        return hintString.split(',').map((entry, idx) => {
            const [name, explicit] = entry.split(':');
            return { value: explicit != null ? parseInt(explicit, 10) : idx, label: name.trim() };
        });
    }, [hintString]);

    const current = asNumber(value);

    if (options.length === 0) {
        return (
            <NumberEditor value={current} step={1} onCommit={(n) => onCommit(Math.round(n))} />
        );
    }

    return (
        <select
            value={current}
            onChange={(e) => onCommit(parseInt(e.target.value, 10))}
            className={textInputClass()}
        >
            {options.map((opt) => (
                <option key={`${opt.value}-${opt.label}`} value={opt.value} className="bg-zinc-900">
                    {opt.label}
                </option>
            ))}
        </select>
    );
}

// ── Property dispatcher ──────────────────────────────────────────────

interface PropertyEditorProps {
    property: NodeProperty;
    onCommit: (value: unknown) => void;
}

function PropertyEditor({ property, onCommit }: PropertyEditorProps) {
    switch (property.type) {
        case 'bool':
            return <BoolEditor value={!!property.value} onCommit={onCommit} />;
        case 'int':
            if (property.hint === 'enum') {
                return <EnumEditor value={property.value} hintString={property.hintString} onCommit={onCommit} />;
            }
            return (
                <NumberEditor
                    value={asNumber(property.value)}
                    step={1}
                    onCommit={(n) => onCommit(Math.round(n))}
                />
            );
        case 'float':
            return <NumberEditor value={asNumber(property.value)} onCommit={onCommit} />;
        case 'string':
            return (
                <StringEditor
                    value={String(property.value ?? '')}
                    multiline={property.hint === 'multiline'}
                    onCommit={onCommit}
                />
            );
        case 'vector2':
            return <VectorEditor value={asVector(property.value, 2)} size={2} onCommit={onCommit} />;
        case 'vector3':
            return <VectorEditor value={asVector(property.value, 3)} size={3} onCommit={onCommit} />;
        case 'vector4':
            return <VectorEditor value={asVector(property.value, 4)} size={4} onCommit={onCommit} />;
        case 'color':
            return (
                <ColorEditor
                    value={asColor(property.value)}
                    noAlpha={property.hint === 'color_no_alpha'}
                    onCommit={onCommit}
                />
            );
        case 'enum':
            return <EnumEditor value={property.value} hintString={property.hintString} onCommit={onCommit} />;
        case 'node_path':
            return <StringEditor value={String(property.value ?? '')} onCommit={onCommit} />;
        case 'resource':
        case 'object':
        default:
            return (
                <span className="text-[10px] font-mono text-zinc-600 truncate block">
                    {property.value == null ? '<null>' : JSON.stringify(property.value).slice(0, 40)}
                </span>
            );
    }
}

// ── Main panel ───────────────────────────────────────────────────────

export default function InspectorPanel() {
    const selectedNodePath = useEditorStore((s) => s.selectedNodePath);
    const setSelectedNodePath = useEditorStore((s) => s.setSelectedNodePath);
    const sceneTreeRevision = useEditorStore((s) => s.sceneTreeRevision);

    const [data, setData] = useState<NodeInspectorData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchNode = useCallback(async () => {
        if (!selectedNodePath || !engineBridge.isReady) {
            setData(null);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const info = await engineBridge.getNodeInfo(selectedNodePath);
            setData(info);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setData(null);
        } finally {
            setLoading(false);
        }
    }, [selectedNodePath]);

    useEffect(() => {
        fetchNode();
    }, [fetchNode, sceneTreeRevision]);

    // Watch for transform changes on the selected node and refresh in place.
    useEffect(() => {
        const unsubscribe = engineBridge.onMessage((msg) => {
            if (msg.type === 'node-transform-changed' && msg.path === selectedNodePath) {
                fetchNode();
            }
        });
        return unsubscribe;
    }, [fetchNode, selectedNodePath]);

    const handleCommit = useCallback(
        async (propertyName: string, value: unknown) => {
            if (!selectedNodePath) return;
            try {
                await engineBridge.setProperty(selectedNodePath, propertyName, value);
                // Optimistic local update so the UI doesn't blink.
                setData((prev) => {
                    if (!prev) return prev;
                    return {
                        ...prev,
                        properties: prev.properties.map((p) =>
                            p.name === propertyName ? { ...p, value } : p,
                        ),
                    };
                });
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            }
        },
        [selectedNodePath],
    );

    // Group properties by category rows (usage === 'category').
    const groups = useMemo(() => {
        if (!data) return [] as Array<{ name: string; items: NodeProperty[] }>;
        const out: Array<{ name: string; items: NodeProperty[] }> = [{ name: 'General', items: [] }];
        for (const p of data.properties) {
            if (p.usage === 'category') {
                out.push({ name: p.name, items: [] });
            } else if (p.usage === 'group') {
                out.push({ name: p.name, items: [] });
            } else if (p.usage !== 'editor' && p.usage !== 'default' && p.usage !== 'storage' && p.usage !== undefined) {
                // skip unknown usages
            } else {
                out[out.length - 1].items.push(p);
            }
        }
        return out.filter((g) => g.items.length > 0);
    }, [data]);

    if (!selectedNodePath) {
        return (
            <div className="h-full flex flex-col bg-zinc-950/80">
                <div className="flex items-center gap-1.5 px-3 py-2 border-b border-white/5 text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                    <Sliders size={12} className="text-violet-400" />
                    Inspector
                </div>
                <div className="flex-1 flex items-center justify-center text-[11px] text-zinc-600 p-4 text-center">
                    Select a node in the Hierarchy to inspect its properties.
                </div>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col bg-zinc-950/80">
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 flex-shrink-0">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-400 uppercase tracking-wider min-w-0">
                    <Sliders size={12} className="text-violet-400 flex-shrink-0" />
                    <span className="truncate">{data?.name ?? 'Inspector'}</span>
                    {data?.type && (
                        <span className="text-[10px] font-mono text-zinc-600 normal-case tracking-normal">
                            ({data.type})
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                        onClick={fetchNode}
                        disabled={loading}
                        className="p-1 hover:bg-white/10 rounded transition-colors"
                        title="Refresh"
                    >
                        <RefreshCw size={10} className={`text-zinc-500 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                        onClick={() => {
                            setSelectedNodePath(null);
                            engineBridge.selectNode(null);
                        }}
                        className="p-1 hover:bg-white/10 rounded transition-colors"
                        title="Deselect"
                    >
                        <X size={10} className="text-zinc-500" />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800">
                {error && (
                    <div className="mx-3 my-2 flex items-start gap-1.5 px-2 py-1.5 rounded bg-red-500/10 border border-red-500/20 text-[10px] text-red-300">
                        <AlertCircle size={11} className="flex-shrink-0 mt-0.5" />
                        <span className="font-mono break-all">{error}</span>
                    </div>
                )}

                {!data && !error && (
                    <div className="px-3 py-4 text-[11px] text-zinc-600">
                        {loading ? 'Loading…' : 'No data.'}
                    </div>
                )}

                {data && (
                    <>
                        <div className="px-3 py-1.5 border-b border-white/5 text-[10px] font-mono text-zinc-600 truncate">
                            {data.path}
                        </div>

                        {groups.map((group) => (
                            <div key={group.name} className="border-b border-white/[0.03]">
                                <div className="px-3 py-1 bg-white/[0.02] text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                                    {group.name}
                                </div>
                                {group.items.map((prop) => (
                                    <Row key={prop.name} label={prop.name}>
                                        <PropertyEditor
                                            property={prop}
                                            onCommit={(value) => handleCommit(prop.name, value)}
                                        />
                                    </Row>
                                ))}
                            </div>
                        ))}

                        {data.script && (
                            <div className="border-b border-white/[0.03]">
                                <div className="px-3 py-1 bg-white/[0.02] text-[10px] font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
                                    <FileCode2 size={10} />
                                    Script
                                </div>
                                <div className="px-3 py-2 text-[10px] font-mono text-zinc-400 truncate">
                                    {data.script}
                                </div>
                            </div>
                        )}

                        {data.properties.length === 0 && (
                            <div className="px-3 py-4 text-[11px] text-zinc-600 flex items-center gap-2">
                                <Box size={12} />
                                No editable properties.
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
