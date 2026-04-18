'use client';

import { useCallback, useEffect, useState } from 'react';
import {
    ChevronDown,
    ChevronRight,
    RefreshCw,
    Layers,
    Box,
    Camera,
    Lightbulb,
    MousePointer2,
    Image as ImageIcon,
    FileCode2,
    Eye,
    EyeOff,
    Circle,
} from 'lucide-react';
import { engineBridge } from '@/lib/engine/bridge';
import type { SceneNodeSnapshot } from '@/types/engine';
import { useEditorStore } from '@/lib/store';

/** Icon for a given Godot/Axiom node type. */
function TypeIcon({ type, className }: { type: string; className?: string }) {
    const iconProps = { size: 11, className };
    if (type.includes('Camera')) return <Camera {...iconProps} />;
    if (type.includes('Light') || type.includes('Omni') || type.includes('Spot') || type.includes('Directional')) return <Lightbulb {...iconProps} />;
    if (type.includes('Sprite') || type.includes('Texture') || type.includes('Image')) return <ImageIcon {...iconProps} />;
    if (type === 'Script' || type.endsWith('Script')) return <FileCode2 {...iconProps} />;
    if (type === 'Node2D' || type === 'Entity2D' || type.includes('2D')) return <MousePointer2 {...iconProps} />;
    if (type === 'Node3D' || type === 'Entity3D' || type.includes('3D') || type.includes('Mesh')) return <Box {...iconProps} />;
    return <Circle {...iconProps} />;
}

interface NodeRowProps {
    node: SceneNodeSnapshot;
    depth: number;
    expanded: Set<string>;
    onToggle: (path: string) => void;
    selectedPath: string | null;
    onSelect: (path: string) => void;
}

function NodeRow({ node, depth, expanded, onToggle, selectedPath, onSelect }: NodeRowProps) {
    const hasChildren = node.children.length > 0;
    const isExpanded = expanded.has(node.path);
    const isSelected = selectedPath === node.path;

    return (
        <div>
            <button
                onClick={() => onSelect(node.path)}
                onDoubleClick={() => hasChildren && onToggle(node.path)}
                className={`w-full flex items-center gap-1 px-2 py-1 text-[11px] transition-colors ${
                    isSelected
                        ? 'bg-violet-500/20 text-violet-200'
                        : 'text-zinc-300 hover:bg-white/[0.03]'
                }`}
                style={{ paddingLeft: `${depth * 12 + 8}px` }}
            >
                {hasChildren ? (
                    <span
                        role="button"
                        tabIndex={-1}
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggle(node.path);
                        }}
                        className="flex-shrink-0 hover:text-white"
                    >
                        {isExpanded
                            ? <ChevronDown size={10} className="text-zinc-500" />
                            : <ChevronRight size={10} className="text-zinc-500" />}
                    </span>
                ) : (
                    <span className="w-[10px] flex-shrink-0" />
                )}
                <TypeIcon type={node.type} className={isSelected ? 'text-violet-300' : 'text-zinc-500'} />
                <span className="truncate flex-1 text-left">{node.name}</span>
                <span className="text-[9px] text-zinc-600 font-mono truncate max-w-[80px]">{node.type}</span>
                {node.visible
                    ? <Eye size={10} className="text-zinc-500" />
                    : <EyeOff size={10} className="text-zinc-700" />}
            </button>
            {isExpanded && hasChildren && (
                <div>
                    {node.children.map((child) => (
                        <NodeRow
                            key={child.path}
                            node={child}
                            depth={depth + 1}
                            expanded={expanded}
                            onToggle={onToggle}
                            selectedPath={selectedPath}
                            onSelect={onSelect}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export default function HierarchyPanel() {
    const selectedNodePath = useEditorStore((s) => s.selectedNodePath);
    const setSelectedNodePath = useEditorStore((s) => s.setSelectedNodePath);
    const sceneTreeRevision = useEditorStore((s) => s.sceneTreeRevision);
    const bumpSceneTreeRevision = useEditorStore((s) => s.bumpSceneTreeRevision);
    const isPlaying = useEditorStore((s) => s.isPlaying);

    const [tree, setTree] = useState<SceneNodeSnapshot | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const fetchTree = useCallback(async () => {
        if (!engineBridge.isReady) {
            setTree(null);
            setError(null);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const snap = await engineBridge.getSceneTree();
            setTree(snap);
            // Auto-expand the root so something is visible.
            setExpanded((prev) => {
                if (prev.has(snap.path)) return prev;
                const next = new Set(prev);
                next.add(snap.path);
                return next;
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setTree(null);
        } finally {
            setLoading(false);
        }
    }, []);

    // Refetch on play/stop and on explicit revision bumps.
    useEffect(() => {
        fetchTree();
    }, [fetchTree, isPlaying, sceneTreeRevision]);

    // Listen for scene-tree-changed events from the engine.
    useEffect(() => {
        const unsubscribe = engineBridge.onMessage((msg) => {
            if (msg.type === 'scene-tree-changed') {
                bumpSceneTreeRevision();
            } else if (msg.type === 'selection-changed') {
                setSelectedNodePath(msg.path);
            } else if (msg.type === 'ready' || msg.type === 'started') {
                bumpSceneTreeRevision();
            }
        });
        return unsubscribe;
    }, [bumpSceneTreeRevision, setSelectedNodePath]);

    const handleToggle = useCallback((path: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, []);

    const handleSelect = useCallback((path: string) => {
        setSelectedNodePath(path);
        engineBridge.selectNode(path);
    }, [setSelectedNodePath]);

    return (
        <div className="h-full flex flex-col bg-zinc-950/80">
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 flex-shrink-0">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                    <Layers size={12} className="text-violet-400" />
                    Hierarchy
                </div>
                <button
                    onClick={fetchTree}
                    disabled={loading}
                    className="p-1 hover:bg-white/10 rounded transition-colors"
                    title="Refresh scene tree"
                >
                    <RefreshCw size={10} className={`text-zinc-500 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800">
                {!engineBridge.isReady && (
                    <div className="px-3 py-4 text-[11px] text-zinc-600">
                        Engine not ready. Start the game to inspect the live scene.
                    </div>
                )}
                {engineBridge.isReady && !tree && !loading && !error && (
                    <div className="px-3 py-4 text-[11px] text-zinc-600">
                        No scene loaded.
                    </div>
                )}
                {error && (
                    <div className="px-3 py-4 text-[11px] text-red-400/80 font-mono">
                        {error}
                    </div>
                )}
                {tree && (
                    <NodeRow
                        node={tree}
                        depth={0}
                        expanded={expanded}
                        onToggle={handleToggle}
                        selectedPath={selectedNodePath}
                        onSelect={handleSelect}
                    />
                )}
            </div>
        </div>
    );
}
