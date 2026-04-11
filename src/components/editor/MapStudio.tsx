'use client';

import { useState } from 'react';
import { useEditorStore } from '@/lib/store';
import { useMapEditorStore, type MapTool } from '@/lib/map-store';
import type { Asset, MapMetadataShape, MapMode } from '@/types/asset';
import {
    Map as MapIcon,
    Wand2,
    Paintbrush,
    Eraser,
    MousePointer,
    Move,
    Sparkles,
    Loader2,
    Plus,
    Grid3X3,
    Trees,
    Repeat,
    X,
} from 'lucide-react';

const GRID_SIZES = [
    { label: '8×8', w: 8, h: 8 },
    { label: '12×12', w: 12, h: 12 },
    { label: '16×12', w: 16, h: 12 },
    { label: '24×16', w: 24, h: 16 },
    { label: '32×24', w: 32, h: 24 },
];

const TILE_SIZES = [16, 24, 32, 48];

// ── Generate Tab ────────────────────────────────────────────────────

function GenerateMapTab() {
    const { project, assetGenerating, setAssetGenerating, addConsoleEntry, addAsset, refreshProjectFiles } = useEditorStore();
    const open = useMapEditorStore(s => s.open);
    const [prompt, setPrompt] = useState('');
    const [tilePromptsText, setTilePromptsText] = useState('');
    const [objectPromptsText, setObjectPromptsText] = useState('');
    const [tileSize, setTileSize] = useState(32);
    const [gridIdx, setGridIdx] = useState(2);
    const [mode, setMode] = useState<MapMode>('fixed');
    const [error, setError] = useState<string | null>(null);

    const grid = GRID_SIZES[gridIdx];

    const handleGenerate = async () => {
        if (!prompt.trim() || !project?.id) return;
        setAssetGenerating(true);
        setError(null);

        const slug = prompt.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
        const targetPath = `assets/maps/${slug}.png`;

        const tilePrompts = tilePromptsText.split('\n').map(s => s.trim()).filter(Boolean);
        const objectPrompts = objectPromptsText.split('\n').map(s => s.trim()).filter(Boolean);

        addConsoleEntry({
            id: crypto.randomUUID(), level: 'log',
            message: `[Map Studio] Generating map "${prompt}" (${grid.w}×${grid.h}, ${tileSize}px)…`,
            timestamp: new Date().toISOString(),
        });

        try {
            const res = await fetch('/api/assets/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project_id: project.id,
                    prompt: prompt.trim(),
                    asset_type: 'map',
                    target_path: targetPath,
                    options: {
                        tile_prompts: tilePrompts.length ? tilePrompts : undefined,
                        object_prompts: objectPrompts.length ? objectPrompts : undefined,
                        tile_size: tileSize,
                        grid_w: grid.w,
                        grid_h: grid.h,
                        mode,
                    },
                }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                setError(data.error || 'Map generation failed');
                addConsoleEntry({ id: crypto.randomUUID(), level: 'error', message: `[Map Studio] Failed: ${data.error}`, timestamp: new Date().toISOString() });
                return;
            }
            const out = data.output as Record<string, unknown>;
            const metadata = out.map_metadata as MapMetadataShape | undefined;
            if (!metadata) {
                setError('Map generation succeeded but returned no metadata — cannot edit');
                return;
            }
            const assetId = crypto.randomUUID();
            const asset: Asset = {
                id: assetId,
                project_id: project.id,
                name: prompt.trim().slice(0, 40),
                asset_type: 'map',
                storage_key: (data.storage_key || out.storage_key) as string,
                thumbnail_key: null,
                file_format: 'png',
                width: (out.width as number) ?? grid.w * tileSize,
                height: (out.height as number) ?? grid.h * tileSize,
                metadata: { map: metadata, tags: ['map'] },
                generation_prompt: prompt.trim(),
                generation_model: 'pixellab-map',
                size_bytes: 0,
                created_at: new Date().toISOString(),
            };
            addAsset(asset);
            refreshProjectFiles(project.id);
            open(assetId, metadata);
            addConsoleEntry({
                id: crypto.randomUUID(), level: 'log',
                message: `[Map Studio] Map generated → ${targetPath}`,
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Network error');
        } finally {
            setAssetGenerating(false);
        }
    };

    return (
        <div className="flex flex-col gap-3 p-3 overflow-y-auto flex-1">
            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Map theme</label>
                <textarea
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    rows={2}
                    placeholder='e.g. "grassy meadow with dirt paths and ponds"'
                    className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-violet-500/50 transition-colors"
                />
            </div>

            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Tile prompts (optional, one per line)</label>
                <textarea
                    value={tilePromptsText}
                    onChange={e => setTilePromptsText(e.target.value)}
                    rows={3}
                    placeholder={'grass ground\ndirt path\nwater pond'}
                    className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-violet-500/50 transition-colors"
                />
                <p className="text-[9px] text-zinc-600 mt-1">Leave blank to auto-derive 3 tiles from theme.</p>
            </div>

            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Object prompts (optional)</label>
                <textarea
                    value={objectPromptsText}
                    onChange={e => setObjectPromptsText(e.target.value)}
                    rows={2}
                    placeholder={'oak tree\nsmall rock'}
                    className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-violet-500/50 transition-colors"
                />
            </div>

            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Grid size</label>
                <div className="flex gap-1 flex-wrap">
                    {GRID_SIZES.map((g, i) => (
                        <button
                            key={g.label}
                            onClick={() => setGridIdx(i)}
                            className={`px-2 py-1 rounded text-xs transition-colors ${
                                gridIdx === i ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'
                            }`}
                        >
                            {g.label}
                        </button>
                    ))}
                </div>
            </div>

            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Tile size — {tileSize}px</label>
                <div className="flex gap-1">
                    {TILE_SIZES.map(s => (
                        <button
                            key={s}
                            onClick={() => setTileSize(s)}
                            className={`flex-1 py-1 rounded text-xs transition-colors ${
                                tileSize === s ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'
                            }`}
                        >
                            {s}
                        </button>
                    ))}
                </div>
            </div>

            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Mode</label>
                <div className="flex gap-1">
                    <button
                        onClick={() => setMode('fixed')}
                        className={`flex-1 py-1.5 rounded text-xs flex items-center justify-center gap-1 transition-colors ${
                            mode === 'fixed' ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'
                        }`}
                    >
                        <Grid3X3 size={11} /> Fixed
                    </button>
                    <button
                        onClick={() => setMode('looping')}
                        className={`flex-1 py-1.5 rounded text-xs flex items-center justify-center gap-1 transition-colors ${
                            mode === 'looping' ? 'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30' : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'
                        }`}
                    >
                        <Repeat size={11} /> Looping
                    </button>
                </div>
                <p className="text-[9px] text-zinc-600 mt-1">Looping wraps visually — useful for endless backgrounds.</p>
            </div>

            {error && <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">{error}</div>}

            <button
                onClick={handleGenerate}
                disabled={!prompt.trim() || assetGenerating}
                className="w-full py-2.5 rounded-lg font-medium text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white shadow-lg shadow-violet-500/20"
            >
                {assetGenerating ? <><Loader2 size={14} className="animate-spin" />Generating map…</> : <><Sparkles size={14} />Generate Map</>}
            </button>
            <p className="text-[9px] text-zinc-600 text-center">Generates N tile sprites + composes a random-filled grid. Edit after in the Edit tab.</p>
        </div>
    );
}

// ── Edit Tab (tool palette + tile library + object library) ────────

function EditTab() {
    const meta = useMapEditorStore(s => s.metadata);
    const tool = useMapEditorStore(s => s.tool);
    const selectedTileId = useMapEditorStore(s => s.selectedTileId);
    const selectedObjectId = useMapEditorStore(s => s.selectedObjectId);
    const setTool = useMapEditorStore(s => s.setTool);
    const selectTile = useMapEditorStore(s => s.selectTile);
    const selectObject = useMapEditorStore(s => s.selectObject);
    const extendGrid = useMapEditorStore(s => s.extendGrid);
    const setMode = useMapEditorStore(s => s.setMode);
    const addTileToLibrary = useMapEditorStore(s => s.addTileToLibrary);
    const addObjectToLibrary = useMapEditorStore(s => s.addObjectToLibrary);

    const { project, addConsoleEntry } = useEditorStore();
    const [newTilePrompt, setNewTilePrompt] = useState('');
    const [newObjectPrompt, setNewObjectPrompt] = useState('');
    const [generating, setGenerating] = useState<'tile' | 'object' | null>(null);
    const [genError, setGenError] = useState<string | null>(null);

    if (!meta) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-600 p-6">
                <MapIcon size={32} strokeWidth={1} />
                <p className="text-sm text-center">No map open</p>
                <p className="text-xs text-center text-zinc-700">Generate a map or select one from the Gallery tab.</p>
            </div>
        );
    }

    const tools: { id: MapTool; icon: typeof Paintbrush; label: string }[] = [
        { id: 'paint', icon: Paintbrush, label: 'Paint' },
        { id: 'erase', icon: Eraser, label: 'Erase' },
        { id: 'place_object', icon: Trees, label: 'Place Object' },
        { id: 'pan', icon: Move, label: 'Pan' },
    ];

    const runGenerateTile = async () => {
        if (!newTilePrompt.trim() || !project?.id) return;
        setGenerating('tile');
        setGenError(null);
        try {
            const slug = newTilePrompt.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20);
            const res = await fetch('/api/assets/map-action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'generate_tile',
                    project_id: project.id,
                    prompt: newTilePrompt.trim(),
                    tile_size: meta.tile_size,
                    target_path: `assets/maps/tiles/${slug}_${Date.now() % 10000}.png`,
                }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                setGenError(data.error || 'Tile generation failed');
                return;
            }
            addTileToLibrary(data.tile);
            setNewTilePrompt('');
            addConsoleEntry({
                id: crypto.randomUUID(), level: 'log',
                message: `[Map Studio] Tile added: ${data.tile.name}`,
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            setGenError(err instanceof Error ? err.message : 'Network error');
        } finally {
            setGenerating(null);
        }
    };

    const runGenerateObject = async () => {
        if (!newObjectPrompt.trim() || !project?.id) return;
        setGenerating('object');
        setGenError(null);
        try {
            const slug = newObjectPrompt.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20);
            const res = await fetch('/api/assets/map-action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'generate_object',
                    project_id: project.id,
                    prompt: newObjectPrompt.trim(),
                    tile_size: meta.tile_size,
                    target_path: `assets/maps/objects/${slug}_${Date.now() % 10000}.png`,
                }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                setGenError(data.error || 'Object generation failed');
                return;
            }
            addObjectToLibrary(data.object);
            setNewObjectPrompt('');
        } catch (err) {
            setGenError(err instanceof Error ? err.message : 'Network error');
        } finally {
            setGenerating(null);
        }
    };

    return (
        <div className="flex flex-col gap-3 p-3 overflow-y-auto flex-1">
            {/* Tool palette */}
            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Tool</label>
                <div className="grid grid-cols-4 gap-1">
                    {tools.map(t => {
                        const Icon = t.icon;
                        return (
                            <button
                                key={t.id}
                                onClick={() => setTool(t.id)}
                                className={`flex flex-col items-center justify-center gap-0.5 py-2 rounded transition-colors ${
                                    tool === t.id ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'
                                }`}
                                title={t.label}
                            >
                                <Icon size={13} />
                                <span className="text-[9px]">{t.label}</span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Mode */}
            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Render mode</label>
                <div className="flex gap-1">
                    <button
                        onClick={() => setMode('fixed')}
                        className={`flex-1 py-1 rounded text-xs transition-colors ${meta.mode === 'fixed' ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'}`}
                    >Fixed</button>
                    <button
                        onClick={() => setMode('looping')}
                        className={`flex-1 py-1 rounded text-xs transition-colors ${meta.mode === 'looping' ? 'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30' : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'}`}
                    >Looping</button>
                </div>
            </div>

            {/* Extend grid */}
            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Extend grid ({meta.grid_w}×{meta.grid_h})</label>
                <div className="grid grid-cols-2 gap-1">
                    <button onClick={() => extendGrid(1, 0)} className="py-1 rounded text-xs bg-zinc-900 text-zinc-400 border border-white/5 hover:text-zinc-200 hover:border-white/10 transition-colors">+col →</button>
                    <button onClick={() => extendGrid(-1, 0)} disabled={meta.grid_w <= 1} className="py-1 rounded text-xs bg-zinc-900 text-zinc-400 border border-white/5 hover:text-zinc-200 hover:border-white/10 disabled:opacity-30 transition-colors">−col</button>
                    <button onClick={() => extendGrid(0, 1)} className="py-1 rounded text-xs bg-zinc-900 text-zinc-400 border border-white/5 hover:text-zinc-200 hover:border-white/10 transition-colors">+row ↓</button>
                    <button onClick={() => extendGrid(0, -1)} disabled={meta.grid_h <= 1} className="py-1 rounded text-xs bg-zinc-900 text-zinc-400 border border-white/5 hover:text-zinc-200 hover:border-white/10 disabled:opacity-30 transition-colors">−row</button>
                </div>
            </div>

            {/* Tile library */}
            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Tile palette · {meta.tiles.length}</label>
                <div className="grid grid-cols-4 gap-1">
                    {meta.tiles.map(t => (
                        <button
                            key={t.id}
                            onClick={() => { selectTile(t.id); setTool('paint'); }}
                            className={`aspect-square rounded border overflow-hidden relative ${
                                selectedTileId === t.id ? 'border-violet-500 ring-1 ring-violet-500/30' : 'border-white/5 hover:border-white/10'
                            }`}
                            title={t.name}
                        >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={`/api/assets/serve?key=${encodeURIComponent(t.storage_key)}`}
                                alt={t.name}
                                className="absolute inset-0 w-full h-full object-cover"
                                style={{ imageRendering: 'pixelated' }}
                            />
                        </button>
                    ))}
                </div>
                <div className="flex gap-1 mt-2">
                    <input
                        value={newTilePrompt}
                        onChange={e => setNewTilePrompt(e.target.value)}
                        placeholder="New tile prompt"
                        className="flex-1 bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50"
                    />
                    <button
                        onClick={runGenerateTile}
                        disabled={!newTilePrompt.trim() || generating === 'tile'}
                        className="px-2 py-1 rounded bg-violet-500/20 text-violet-300 text-xs hover:bg-violet-500/30 disabled:opacity-30 transition-colors flex items-center gap-1"
                    >
                        {generating === 'tile' ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                    </button>
                </div>
            </div>

            {/* Object library */}
            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Objects · {meta.objects_library.length}</label>
                <div className="grid grid-cols-4 gap-1">
                    {meta.objects_library.map(o => (
                        <button
                            key={o.id}
                            onClick={() => { selectObject(o.id); setTool('place_object'); }}
                            className={`aspect-square rounded border overflow-hidden relative bg-zinc-900 ${
                                selectedObjectId === o.id ? 'border-fuchsia-500 ring-1 ring-fuchsia-500/30' : 'border-white/5 hover:border-white/10'
                            }`}
                            title={o.name}
                        >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={`/api/assets/serve?key=${encodeURIComponent(o.storage_key)}`}
                                alt={o.name}
                                className="absolute inset-0 w-full h-full object-contain p-0.5"
                                style={{ imageRendering: 'pixelated' }}
                            />
                        </button>
                    ))}
                </div>
                <div className="flex gap-1 mt-2">
                    <input
                        value={newObjectPrompt}
                        onChange={e => setNewObjectPrompt(e.target.value)}
                        placeholder="New object prompt"
                        className="flex-1 bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-fuchsia-500/50"
                    />
                    <button
                        onClick={runGenerateObject}
                        disabled={!newObjectPrompt.trim() || generating === 'object'}
                        className="px-2 py-1 rounded bg-fuchsia-500/20 text-fuchsia-300 text-xs hover:bg-fuchsia-500/30 disabled:opacity-30 transition-colors flex items-center gap-1"
                    >
                        {generating === 'object' ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                    </button>
                </div>
            </div>

            {genError && <div className="px-3 py-1.5 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-xs">{genError}</div>}

            <p className="text-[9px] text-zinc-600 leading-relaxed mt-1">
                Left-click: apply tool · Right-click: delete object · Middle-drag or Cmd/Ctrl+drag: pan · Wheel: zoom · Cmd/Ctrl+Z: undo
            </p>
        </div>
    );
}

// ── Gallery Tab (list of existing maps) ────────────────────────────

function MapsGalleryTab() {
    const assets = useEditorStore(s => s.assets);
    const open = useMapEditorStore(s => s.open);
    const openAssetId = useMapEditorStore(s => s.assetId);
    const maps = assets.filter(a => a.asset_type === 'map');

    if (maps.length === 0) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-600 p-6">
                <MapIcon size={32} strokeWidth={1} />
                <p className="text-sm text-center">No maps yet</p>
                <p className="text-xs text-center text-zinc-700">Create one in the Generate tab.</p>
            </div>
        );
    }
    return (
        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
            {maps.map(m => {
                const mapMeta = (m.metadata?.map as MapMetadataShape | undefined);
                const isOpen = m.id === openAssetId;
                return (
                    <button
                        key={m.id}
                        onClick={() => mapMeta && open(m.id, mapMeta)}
                        className={`flex items-center gap-2 p-2 rounded border transition-colors ${
                            isOpen ? 'border-violet-500 bg-violet-500/5' : 'border-white/5 bg-zinc-900/50 hover:border-white/10'
                        }`}
                    >
                        <div className="w-12 h-12 rounded bg-zinc-900 overflow-hidden flex-shrink-0 border border-white/5">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={`/api/assets/serve?key=${encodeURIComponent(m.storage_key)}`}
                                alt={m.name}
                                className="w-full h-full object-contain"
                                style={{ imageRendering: 'pixelated' }}
                            />
                        </div>
                        <div className="flex-1 min-w-0 text-left">
                            <div className="text-xs text-zinc-200 truncate">{m.name}</div>
                            <div className="text-[10px] text-zinc-500 font-mono">
                                {mapMeta ? `${mapMeta.grid_w}×${mapMeta.grid_h} · ${mapMeta.tile_size}px · ${mapMeta.mode}` : 'legacy'}
                            </div>
                        </div>
                    </button>
                );
            })}
        </div>
    );
}

// ── Main Component ─────────────────────────────────────────────────

type Tab = 'generate' | 'edit' | 'gallery';

const TABS: { id: Tab; label: string; icon: typeof Wand2 }[] = [
    { id: 'generate', label: 'Generate', icon: Wand2 },
    { id: 'edit', label: 'Edit', icon: MousePointer },
    { id: 'gallery', label: 'Gallery', icon: Grid3X3 },
];

export default function MapStudio() {
    const setActiveRightPanel = useEditorStore(s => s.setActiveRightPanel);
    const openAssetId = useMapEditorStore(s => s.assetId);
    const closeMap = useMapEditorStore(s => s.close);
    const [tab, setTab] = useState<Tab>('generate');

    // When a newly-opened map arrives, auto-switch to Edit. This is the
    // "adjust state while rendering" pattern (react.dev/learn/you-might-not-need-an-effect).
    const [lastOpenAssetId, setLastOpenAssetId] = useState<string | null>(null);
    if (openAssetId !== lastOpenAssetId) {
        setLastOpenAssetId(openAssetId);
        if (openAssetId) setTab('edit');
    }

    return (
        <div className="flex flex-col h-full bg-zinc-950">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded bg-gradient-to-br from-emerald-500 to-cyan-600 flex items-center justify-center">
                        <MapIcon size={10} className="text-white" />
                    </div>
                    <span className="text-sm font-semibold text-zinc-200">Map Studio</span>
                </div>
                <div className="flex items-center gap-1">
                    {openAssetId && (
                        <button
                            onClick={closeMap}
                            className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                            title="Close map"
                        >
                            <X size={12} />
                        </button>
                    )}
                    <button
                        onClick={() => setActiveRightPanel('chat')}
                        className="text-[10px] text-zinc-500 hover:text-zinc-300 px-2 py-0.5 rounded hover:bg-white/5 transition-colors"
                    >
                        Back to Chat
                    </button>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-white/5">
                {TABS.map(t => {
                    const Icon = t.icon;
                    return (
                        <button
                            key={t.id}
                            onClick={() => setTab(t.id)}
                            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs transition-colors ${
                                tab === t.id ? 'text-emerald-400 border-b-2 border-emerald-500 bg-emerald-500/5' : 'text-zinc-500 hover:text-zinc-300'
                            }`}
                        >
                            <Icon size={12} />
                            {t.label}
                        </button>
                    );
                })}
            </div>

            {tab === 'generate' && <GenerateMapTab />}
            {tab === 'edit' && <EditTab />}
            {tab === 'gallery' && <MapsGalleryTab />}
        </div>
    );
}
