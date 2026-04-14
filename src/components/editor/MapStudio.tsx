'use client';

import { useState } from 'react';
import { useEditorStore } from '@/lib/store';
import { useMapEditorStore, type MapTool } from '@/lib/map-store';
import type { Asset, MapMetadataShape, MapMode, MapProjection, TerrainCorner } from '@/types/asset';
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
    Box,
    Square,
    Layers,
    Minus,
} from 'lucide-react';

const GRID_SIZES = [
    { label: '8×8', w: 8, h: 8 },
    { label: '12×12', w: 12, h: 12 },
    { label: '16×12', w: 16, h: 12 },
    { label: '24×16', w: 24, h: 16 },
    { label: '32×24', w: 32, h: 24 },
];

const TILE_SIZES = [16, 24, 32, 48];

const TERRAIN_COLORS: Record<TerrainCorner, string> = {
    lower: 'from-emerald-600 to-green-700',
    upper: 'from-stone-500 to-stone-700',
    transition: 'from-amber-600 to-orange-700',
};

// Server errors can arrive as a string, a Supabase PostgrestError
// ({ code, message, details, hint }), or a Vercel platform envelope
// ({ code, id, message }) when a serverless function times out. Rendering
// any of those objects as a React child throws React error #31, so this
// coerces every shape down to a string for safe display.
function errorMessage(raw: unknown, fallback: string): string {
    if (typeof raw === 'string' && raw.length > 0) return raw;
    if (raw && typeof raw === 'object' && 'message' in raw) {
        const m = (raw as { message: unknown }).message;
        if (typeof m === 'string' && m.length > 0) return m;
    }
    return fallback;
}

// ── Generate Tab ────────────────────────────────────────────────────

function GenerateMapTab() {
    const { project, assetGenerating, setAssetGenerating, addConsoleEntry, addAsset, refreshProjectFiles } = useEditorStore();
    const open = useMapEditorStore(s => s.open);

    const [prompt, setPrompt] = useState('');
    const [projection, setProjection] = useState<MapProjection>('orthogonal');
    // Orthogonal (Wang) inputs
    const [lowerPrompt, setLowerPrompt] = useState('');
    const [upperPrompt, setUpperPrompt] = useState('');
    const [transitionPrompt, setTransitionPrompt] = useState('');
    // Isometric inputs
    const [isoVariantsText, setIsoVariantsText] = useState('');
    const [isoView, setIsoView] = useState<'top-down' | 'high top-down' | 'low top-down' | 'side'>('low top-down');
    const [isoDepthRatio, setIsoDepthRatio] = useState<number>(0.5); // 0 flat → 1 full block
    const [isoTileHeight, setIsoTileHeight] = useState<string>(''); // empty = auto (PixelLab decides)

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

        const isoVariantPrompts = isoVariantsText.split('\n').map(s => s.trim()).filter(Boolean);

        addConsoleEntry({
            id: crypto.randomUUID(), level: 'log',
            message: `[Map Studio] Generating ${projection} map "${prompt}" (${grid.w}×${grid.h}, ${tileSize}px)…`,
            timestamp: new Date().toISOString(),
        });

        try {
            const abort = new AbortController();
            const timer = setTimeout(() => abort.abort(), 270_000);

            const options: Record<string, unknown> = {
                projection,
                tile_size: tileSize,
                grid_w: grid.w,
                grid_h: grid.h,
                mode,
            };
            if (projection === 'orthogonal') {
                if (lowerPrompt.trim()) options.lower = lowerPrompt.trim();
                if (upperPrompt.trim()) options.upper = upperPrompt.trim();
                if (transitionPrompt.trim()) options.transition = transitionPrompt.trim();
            } else {
                if (isoVariantPrompts.length) options.iso_variant_prompts = isoVariantPrompts;
                options.iso_tile_view = isoView;
                options.iso_depth_ratio = isoDepthRatio;
                const parsedHeight = parseInt(isoTileHeight, 10);
                if (Number.isFinite(parsedHeight) && parsedHeight >= 16 && parsedHeight <= 256) {
                    options.iso_tile_height = parsedHeight;
                }
            }

            const res = await fetch('/api/assets/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: abort.signal,
                body: JSON.stringify({
                    project_id: project.id,
                    prompt: prompt.trim(),
                    asset_type: 'map',
                    target_path: targetPath,
                    options,
                }),
            });
            clearTimeout(timer);
            const data = await res.json();
            if (!res.ok || !data.success) {
                const errMsg = errorMessage(data.error, `Map generation failed (HTTP ${res.status})`);
                setError(errMsg);
                addConsoleEntry({ id: crypto.randomUUID(), level: 'error', message: `[Map Studio] Failed: ${errMsg}`, timestamp: new Date().toISOString() });
                return;
            }
            const out = data.output as Record<string, unknown>;
            const metadata = out.map_metadata as MapMetadataShape | undefined;
            if (!metadata) {
                setError('Map generation succeeded but returned no metadata — cannot edit');
                return;
            }
            // Use the asset_id returned by the server (registerMapAsset inserted
            // the row under that id). Falling back to a fresh UUID would leave
            // the client and DB out of sync — save/recompose would target the
            // wrong row.
            const assetId = (out.asset_id as string | undefined) ?? crypto.randomUUID();
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
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Projection</label>
                <div className="flex gap-1">
                    <button
                        onClick={() => setProjection('orthogonal')}
                        className={`flex-1 py-1.5 rounded text-xs flex items-center justify-center gap-1 transition-colors ${
                            projection === 'orthogonal' ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'
                        }`}
                    >
                        <Square size={11} /> Orthogonal (Wang)
                    </button>
                    <button
                        onClick={() => setProjection('isometric')}
                        className={`flex-1 py-1.5 rounded text-xs flex items-center justify-center gap-1 transition-colors ${
                            projection === 'isometric' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'
                        }`}
                    >
                        <Box size={11} /> Isometric
                    </button>
                </div>
                <p className="text-[9px] text-zinc-600 mt-1">
                    {projection === 'orthogonal'
                        ? 'Top-down Wang tileset — 16 auto-tiling variants blend two terrains by corner pattern.'
                        : 'Diamond-projected tile variants — paint any variant onto each cell.'}
                </p>
            </div>

            {projection === 'orthogonal' ? (
                <>
                    <div>
                        <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Lower terrain</label>
                        <input
                            value={lowerPrompt}
                            onChange={e => setLowerPrompt(e.target.value)}
                            placeholder="grass"
                            className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50 transition-colors"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Upper terrain</label>
                        <input
                            value={upperPrompt}
                            onChange={e => setUpperPrompt(e.target.value)}
                            placeholder="stone path"
                            className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50 transition-colors"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Transition band (optional)</label>
                        <input
                            value={transitionPrompt}
                            onChange={e => setTransitionPrompt(e.target.value)}
                            placeholder="mossy edge"
                            className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50 transition-colors"
                        />
                    </div>
                </>
            ) : (
                <>
                    <div>
                        <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Iso tile variants (one per line)</label>
                        <textarea
                            value={isoVariantsText}
                            onChange={e => setIsoVariantsText(e.target.value)}
                            rows={4}
                            placeholder={'grass\ndirt path\nstone block\nwater'}
                            className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-cyan-500/50 transition-colors"
                        />
                        <p className="text-[9px] text-zinc-600 mt-1">Up to 6. Leave blank to auto-derive 3 variants from theme.</p>
                    </div>
                    <div>
                        <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">View angle</label>
                        <div className="flex gap-1">
                            {(['top-down', 'high top-down', 'low top-down', 'side'] as const).map(v => (
                                <button
                                    key={v}
                                    onClick={() => setIsoView(v)}
                                    className={`flex-1 px-1.5 py-1 rounded text-[10px] transition-colors ${
                                        isoView === v
                                            ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                                            : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'
                                    }`}
                                >
                                    {v === 'top-down' ? 'Flat' : v === 'high top-down' ? 'High' : v === 'low top-down' ? 'Low' : 'Side'}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div>
                        <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">
                            Block height — {Math.round(isoDepthRatio * 100)}%
                        </label>
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={isoDepthRatio}
                            onChange={e => setIsoDepthRatio(Number(e.target.value))}
                            className="w-full accent-cyan-500"
                        />
                        <p className="text-[9px] text-zinc-600 mt-1">
                            0% = flat tile, 100% = tall block. Depth ratio is sent directly to PixelLab.
                        </p>
                    </div>
                    <div>
                        <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">
                            Tile height (px) — <span className="normal-case text-zinc-600">{isoTileHeight.trim() ? `${isoTileHeight}px` : 'auto'}</span>
                        </label>
                        <input
                            type="number"
                            min={16}
                            max={256}
                            value={isoTileHeight}
                            onChange={e => setIsoTileHeight(e.target.value)}
                            placeholder={`auto (≈ ${tileSize}–${tileSize * 2}px)`}
                            className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/50 transition-colors"
                        />
                        <p className="text-[9px] text-zinc-600 mt-1">
                            Explicit PNG height (16–256). Leave blank for PixelLab default. Try {tileSize * 2}px for cube blocks, {tileSize * 3}px+ for columns/towers.
                        </p>
                    </div>
                </>
            )}

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
                {projection === 'orthogonal' && (
                    <p className="text-[9px] text-zinc-600 mt-1">Wang tilesets are constrained to 16 or 32 px by PixelLab.</p>
                )}
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
        </div>
    );
}

// ── Edit Tab ────────────────────────────────────────────────────────

function EditTab() {
    const meta = useMapEditorStore(s => s.metadata);
    const tool = useMapEditorStore(s => s.tool);
    const selectedTerrain = useMapEditorStore(s => s.selectedTerrain);
    const selectedIsoTileId = useMapEditorStore(s => s.selectedIsoTileId);
    const selectedObjectId = useMapEditorStore(s => s.selectedObjectId);
    const setTool = useMapEditorStore(s => s.setTool);
    const selectTerrain = useMapEditorStore(s => s.selectTerrain);
    const selectIsoTile = useMapEditorStore(s => s.selectIsoTile);
    const selectObject = useMapEditorStore(s => s.selectObject);
    const extendGrid = useMapEditorStore(s => s.extendGrid);
    const setMode = useMapEditorStore(s => s.setMode);
    const addIsoTileToLibrary = useMapEditorStore(s => s.addIsoTileToLibrary);
    const addObjectToLibrary = useMapEditorStore(s => s.addObjectToLibrary);

    const { project, addConsoleEntry } = useEditorStore();
    const [newIsoPrompt, setNewIsoPrompt] = useState('');
    const [newObjectPrompt, setNewObjectPrompt] = useState('');
    const [generating, setGenerating] = useState<'iso' | 'object' | null>(null);
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

    const isIso = meta.projection === 'isometric';

    const tools: { id: MapTool; icon: typeof Paintbrush; label: string }[] = [
        { id: 'paint', icon: Paintbrush, label: isIso ? 'Paint' : 'Paint Corner' },
        { id: 'erase', icon: Eraser, label: 'Erase' },
        { id: 'place_object', icon: Trees, label: 'Place Object' },
        { id: 'pan', icon: Move, label: 'Pan' },
        ...(isIso ? [
            { id: 'stack_add' as MapTool, icon: Layers, label: 'Stack +' },
            { id: 'stack_pop' as MapTool, icon: Minus, label: 'Stack −' },
        ] : []),
    ];

    const terrainOptions: TerrainCorner[] = ['lower', 'upper'];
    if (meta.terrain_prompts?.transition) terrainOptions.push('transition');

    const runGenerateIsoTile = async () => {
        if (!newIsoPrompt.trim() || !project?.id) return;
        setGenerating('iso');
        setGenError(null);
        try {
            const slug = newIsoPrompt.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20);
            const ts = meta.tile_size === 16 ? 16 : 32;
            const abort = new AbortController();
            const timer = setTimeout(() => abort.abort(), 120_000);
            const res = await fetch('/api/assets/map-action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: abort.signal,
                body: JSON.stringify({
                    action: 'generate_iso_tile',
                    project_id: project.id,
                    prompt: newIsoPrompt.trim(),
                    tile_size: ts,
                    shape: 'block',
                    target_path: `assets/maps/iso_tiles/${slug}_${Date.now() % 10000}.png`,
                }),
            });
            clearTimeout(timer);
            const data = await res.json();
            if (!res.ok || !data.success) {
                setGenError(errorMessage(data.error, `Iso tile generation failed (HTTP ${res.status})`));
                return;
            }
            addIsoTileToLibrary(data.tile);
            setNewIsoPrompt('');
            addConsoleEntry({
                id: crypto.randomUUID(), level: 'log',
                message: `[Map Studio] Iso tile added: ${data.tile.name}`,
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
            const abort = new AbortController();
            const timer = setTimeout(() => abort.abort(), 120_000);
            const res = await fetch('/api/assets/map-action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: abort.signal,
                body: JSON.stringify({
                    action: 'generate_object',
                    project_id: project.id,
                    prompt: newObjectPrompt.trim(),
                    tile_size: meta.tile_size,
                    view: isIso ? 'side' : 'high top-down',
                    target_path: `assets/maps/objects/${slug}_${Date.now() % 10000}.png`,
                }),
            });
            clearTimeout(timer);
            const data = await res.json();
            if (!res.ok || !data.success) {
                setGenError(errorMessage(data.error, `Object generation failed (HTTP ${res.status})`));
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

            {/* Projection + Mode badge */}
            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">
                    Map · <span className="text-zinc-400">{meta.projection}</span>
                </label>
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

            {/* Palette — terrain (ortho) OR iso tile library (iso) */}
            {isIso ? (
                <div>
                    <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Iso tiles · {meta.iso_tiles?.length ?? 0}</label>
                    <div className="grid grid-cols-4 gap-1">
                        {(meta.iso_tiles ?? []).map(t => (
                            <button
                                key={t.id}
                                onClick={() => { selectIsoTile(t.id); setTool('paint'); }}
                                className={`aspect-square rounded border overflow-hidden relative bg-zinc-900 ${
                                    selectedIsoTileId === t.id ? 'border-cyan-500 ring-1 ring-cyan-500/30' : 'border-white/5 hover:border-white/10'
                                }`}
                                title={t.name}
                            >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                    src={`/api/assets/serve?key=${encodeURIComponent(t.storage_key)}`}
                                    alt={t.name}
                                    className="absolute inset-0 w-full h-full object-contain p-0.5"
                                    style={{ imageRendering: 'pixelated' }}
                                />
                            </button>
                        ))}
                    </div>
                    <div className="flex gap-1 mt-2">
                        <input
                            value={newIsoPrompt}
                            onChange={e => setNewIsoPrompt(e.target.value)}
                            placeholder="New iso tile prompt"
                            className="flex-1 bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/50"
                        />
                        <button
                            onClick={runGenerateIsoTile}
                            disabled={!newIsoPrompt.trim() || generating === 'iso'}
                            className="px-2 py-1 rounded bg-cyan-500/20 text-cyan-300 text-xs hover:bg-cyan-500/30 disabled:opacity-30 transition-colors flex items-center gap-1"
                        >
                            {generating === 'iso' ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                        </button>
                    </div>
                </div>
            ) : (
                <div>
                    <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">
                        Terrain brush · {meta.wang_tiles?.length ?? 0} wang tiles
                    </label>
                    <div className="grid grid-cols-3 gap-1">
                        {terrainOptions.map(label => (
                            <button
                                key={label}
                                onClick={() => { selectTerrain(label); setTool('paint'); }}
                                className={`py-4 rounded border text-[10px] font-medium capitalize transition-colors bg-gradient-to-br ${TERRAIN_COLORS[label]} ${
                                    selectedTerrain === label
                                        ? 'border-white ring-1 ring-white/40 text-white'
                                        : 'border-white/10 opacity-70 hover:opacity-100 text-white'
                                }`}
                                title={meta.terrain_prompts?.[label] ?? label}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    {meta.terrain_prompts && (
                        <div className="mt-1.5 text-[9px] text-zinc-600 space-y-0.5">
                            <div>lower: <span className="text-zinc-500">{meta.terrain_prompts.lower}</span></div>
                            <div>upper: <span className="text-zinc-500">{meta.terrain_prompts.upper}</span></div>
                            {meta.terrain_prompts.transition && <div>transition: <span className="text-zinc-500">{meta.terrain_prompts.transition}</span></div>}
                        </div>
                    )}
                </div>
            )}

            {/* Object library */}
            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Objects · {meta.objects_library.length}</label>
                {tool === 'place_object' && meta.objects_library.length === 0 && (
                    <div className="mb-1 px-2 py-1.5 rounded bg-fuchsia-500/10 border border-fuchsia-500/20 text-fuchsia-300 text-[10px] leading-relaxed">
                        Generate an object below to place it on the map.
                    </div>
                )}
                {tool === 'place_object' && meta.objects_library.length > 0 && !selectedObjectId && (
                    <div className="mb-1 px-2 py-1.5 rounded bg-fuchsia-500/10 border border-fuchsia-500/20 text-fuchsia-300 text-[10px] leading-relaxed">
                        Pick an object thumbnail, then click the map to place it.
                    </div>
                )}
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
                {isIso
                    ? 'Left-click: apply tool to cell · Right-click: delete object · Middle-drag / Cmd+drag: pan · Wheel: zoom · Cmd/Ctrl+Z: undo'
                    : 'Left-click: paint corner (Wang auto-tiling) · Right-click: delete object · Middle-drag / Cmd+drag: pan · Wheel: zoom · Cmd/Ctrl+Z: undo'}
            </p>
        </div>
    );
}

// ── Gallery Tab ─────────────────────────────────────────────────────

function MapsGalleryTab() {
    const assets = useEditorStore(s => s.assets);
    const addConsoleEntry = useEditorStore(s => s.addConsoleEntry);
    const open = useMapEditorStore(s => s.open);
    const openAssetId = useMapEditorStore(s => s.assetId);
    const maps = assets.filter(a => a.asset_type === 'map');

    const handleOpen = (assetId: string, meta: MapMetadataShape | undefined) => {
        if (!meta) {
            addConsoleEntry({
                id: crypto.randomUUID(),
                level: 'error',
                message: `[Map Studio] Cannot edit map — missing metadata.map. Re-generate from the Generate tab.`,
                timestamp: new Date().toISOString(),
            });
            return;
        }
        open(assetId, meta);
    };

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
                        onClick={() => handleOpen(m.id, mapMeta)}
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
                                {mapMeta ? `${mapMeta.projection} · ${mapMeta.grid_w}×${mapMeta.grid_h} · ${mapMeta.tile_size}px · ${mapMeta.mode}` : 'legacy'}
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

    // Auto-switch to Edit when a new map is opened.
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
