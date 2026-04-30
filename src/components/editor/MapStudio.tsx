'use client';

import { useState } from 'react';
import { useEditorStore } from '@/lib/store';
import { useMapEditorStore, type MapTool } from '@/lib/map-store';
import type { Asset, MapMetadataShape, MapMode, MapProjection, TerrainCorner } from '@/types/asset';
import { tryParseMapMetadata } from '@/lib/map-schema';
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
    Eye,
    EyeOff,
    Lock,
    Unlock,
    ArrowUp,
    ArrowDown,
    Trash2,
    Pencil,
} from 'lucide-react';
import type { LayerKind } from '@/types/asset';

const GRID_SIZES = [
    { label: '8×8', w: 8, h: 8 },
    { label: '12×12', w: 12, h: 12 },
    { label: '16×12', w: 16, h: 12 },
    { label: '24×16', w: 24, h: 16 },
    { label: '32×24', w: 32, h: 24 },
    { label: '48×32', w: 48, h: 32 },
    { label: '64×48', w: 64, h: 48 },
    { label: '96×64', w: 96, h: 64 },
    { label: '128×96', w: 128, h: 96 },
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
    const [transitionSize, setTransitionSize] = useState<number>(0.5); // 0..1 in 0.25 steps
    // Isometric inputs
    const [isoVariantsText, setIsoVariantsText] = useState('');
    const [isoView, setIsoView] = useState<'top-down' | 'high top-down' | 'low top-down' | 'side'>('low top-down');
    const [isoDepthRatio, setIsoDepthRatio] = useState<number>(0.5); // 0 flat → 1 full block
    const [isoTileHeight, setIsoTileHeight] = useState<string>(''); // empty = auto (PixelLab decides)
    const [isoTileViewAngle, setIsoTileViewAngle] = useState<string>(''); // empty = use preset

    // Art-direction (advanced) — sent through to /create-tileset.
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [outline, setOutline] = useState('');
    const [shading, setShading] = useState('');
    const [detail, setDetail] = useState('');
    const [seedText, setSeedText] = useState('');

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
                if (transitionPrompt.trim()) {
                    options.transition = transitionPrompt.trim();
                    options.transition_size = transitionSize;
                }
            } else {
                if (isoVariantPrompts.length) options.iso_variant_prompts = isoVariantPrompts;
                options.iso_tile_view = isoView;
                options.iso_depth_ratio = isoDepthRatio;
                const parsedHeight = parseInt(isoTileHeight, 10);
                if (Number.isFinite(parsedHeight) && parsedHeight >= 16 && parsedHeight <= 256) {
                    options.iso_tile_height = parsedHeight;
                }
                const parsedViewAngle = parseFloat(isoTileViewAngle);
                if (Number.isFinite(parsedViewAngle) && parsedViewAngle >= 0 && parsedViewAngle <= 90) {
                    options.iso_tile_view_angle = parsedViewAngle;
                }
            }

            // Art-direction passes through for both projections — the orthogonal
            // path uses outline/shading/detail; iso uses seed.
            if (outline.trim()) options.outline = outline.trim();
            if (shading.trim()) options.shading = shading.trim();
            if (detail.trim()) options.detail = detail.trim();
            const parsedSeed = parseInt(seedText, 10);
            if (Number.isFinite(parsedSeed)) options.seed = parsedSeed;

            // Enqueue job — /start returns immediately with a job_id, and the
            // heavy generation runs on a separate worker invocation. This
            // avoids Vercel's per-request timeout on slow maps.
            const startRes = await fetch('/api/assets/generate-map/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project_id: project.id,
                    prompt: prompt.trim(),
                    target_path: targetPath,
                    options,
                }),
            });
            const startData = await startRes.json();
            if (startRes.status === 429) {
                const reason = errorMessage(startData.error, 'Rate limit reached. Try again in a few minutes.');
                setError(reason);
                addConsoleEntry({ id: crypto.randomUUID(), level: 'warn', message: `[Map Studio] ${reason}`, timestamp: new Date().toISOString() });
                return;
            }
            if (!startRes.ok || !startData.success || !startData.job_id) {
                const errMsg = errorMessage(startData.error, `Map generation failed (HTTP ${startRes.status})`);
                setError(errMsg);
                addConsoleEntry({ id: crypto.randomUUID(), level: 'error', message: `[Map Studio] Failed: ${errMsg}`, timestamp: new Date().toISOString() });
                return;
            }
            const jobId = startData.job_id as string;

            // Poll /status until done or timeout. Cap at 10 min — well past
            // any realistic generation, but short enough that hung workers
            // surface instead of spinning forever.
            //
            // Backoff rules:
            //   - Normal tick: 2s.
            //   - On transient HTTP error (5xx / network / non-2xx that isn't
            //     404): double the wait up to 30s so we don't hammer a sick
            //     status endpoint.
            //   - After MAX_FAILS consecutive failures, abort with a clear
            //     error instead of spinning silently for the full 10 min.
            //   - 404 on a valid job_id means the row was deleted server-side;
            //     surface immediately rather than retrying.
            const pollStart = Date.now();
            const pollTimeoutMs = 10 * 60 * 1000;
            const baseIntervalMs = 2000;
            const maxIntervalMs = 30_000;
            const maxConsecutiveFails = 5;

            let finalStatus: { status: string; result: Record<string, unknown> | null; error: string | null } | null = null;
            let consecutiveFails = 0;
            let currentIntervalMs = baseIntervalMs;

            while (Date.now() - pollStart < pollTimeoutMs) {
                await new Promise(r => setTimeout(r, currentIntervalMs));
                let sRes: Response;
                try {
                    sRes = await fetch(`/api/assets/generate-map/status?job_id=${jobId}`);
                } catch {
                    consecutiveFails++;
                    currentIntervalMs = Math.min(currentIntervalMs * 2, maxIntervalMs);
                    if (consecutiveFails >= maxConsecutiveFails) {
                        setError('Lost connection to generation service — please retry');
                        return;
                    }
                    continue;
                }

                if (sRes.status === 404) {
                    setError('Generation job disappeared server-side — please retry');
                    return;
                }
                if (!sRes.ok) {
                    consecutiveFails++;
                    currentIntervalMs = Math.min(currentIntervalMs * 2, maxIntervalMs);
                    if (consecutiveFails >= maxConsecutiveFails) {
                        setError(`Generation service is unhealthy (HTTP ${sRes.status}) — please retry`);
                        return;
                    }
                    continue;
                }

                consecutiveFails = 0;
                currentIntervalMs = baseIntervalMs;
                const sData = await sRes.json();
                if (sData.status === 'done' || sData.status === 'failed') {
                    finalStatus = sData;
                    break;
                }
            }

            if (!finalStatus) {
                setError('Map generation timed out — please try again');
                addConsoleEntry({ id: crypto.randomUUID(), level: 'error', message: '[Map Studio] Timeout waiting for job', timestamp: new Date().toISOString() });
                return;
            }
            if (finalStatus.status === 'failed') {
                const errMsg = errorMessage(finalStatus.error, 'Map generation failed');
                setError(errMsg);
                addConsoleEntry({ id: crypto.randomUUID(), level: 'error', message: `[Map Studio] Failed: ${errMsg}`, timestamp: new Date().toISOString() });
                return;
            }

            const out = (finalStatus.result ?? {}) as Record<string, unknown>;

            // Validate the metadata shape at the network boundary. PixelLab
            // partial responses or server regressions used to silently produce
            // a corrupt map that would later crash MapCanvas — catch it here.
            const parsed = tryParseMapMetadata(out.map_metadata);
            if (!parsed.ok) {
                setError(`Map generation returned invalid metadata: ${parsed.error}`);
                addConsoleEntry({ id: crypto.randomUUID(), level: 'error', message: `[Map Studio] Invalid metadata: ${parsed.error}`, timestamp: new Date().toISOString() });
                return;
            }
            const metadata = parsed.value;

            // asset_id MUST come from the server — registerMapAsset inserted
            // the row under that id. Inventing a random UUID here (as the old
            // fallback did) leaves client and DB silently desynchronized:
            // save/recompose then targets a nonexistent row and every edit
            // dead-ends. Treat its absence as a hard failure.
            const assetId = out.asset_id;
            if (typeof assetId !== 'string' || assetId.length === 0) {
                setError('Map generation succeeded but the server did not register the asset — please retry');
                addConsoleEntry({ id: crypto.randomUUID(), level: 'error', message: '[Map Studio] Missing asset_id in generation result', timestamp: new Date().toISOString() });
                return;
            }
            const asset: Asset = {
                id: assetId,
                project_id: project.id,
                name: prompt.trim().slice(0, 40),
                asset_type: 'map',
                storage_key: out.storage_key as string,
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
                    {transitionPrompt.trim() && (
                        <div>
                            <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">
                                Transition width — {Math.round(transitionSize * 100)}%
                            </label>
                            <div className="flex gap-1">
                                {[0, 0.25, 0.5, 0.75, 1.0].map(v => (
                                    <button
                                        key={v}
                                        onClick={() => setTransitionSize(v)}
                                        className={`flex-1 py-1 rounded text-[10px] transition-colors ${
                                            Math.abs(transitionSize - v) < 0.01
                                                ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                                                : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'
                                        }`}
                                    >
                                        {Math.round(v * 100)}%
                                    </button>
                                ))}
                            </div>
                            <p className="text-[9px] text-zinc-600 mt-1">0% = no blend (hard edge), 100% = full transition tile.</p>
                        </div>
                    )}
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
                        <p className="text-[9px] text-zinc-600 mt-1">Up to 16. Leave blank to auto-derive 3 variants from theme.</p>
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
                    <div>
                        <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">
                            View angle override — <span className="normal-case text-zinc-600">{isoTileViewAngle.trim() ? `${isoTileViewAngle}°` : 'use preset'}</span>
                        </label>
                        <input
                            type="number"
                            min={0}
                            max={90}
                            value={isoTileViewAngle}
                            onChange={e => setIsoTileViewAngle(e.target.value)}
                            placeholder="auto (uses View angle preset)"
                            className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/50 transition-colors"
                        />
                        <p className="text-[9px] text-zinc-600 mt-1">
                            Continuous angle 0–90° (overrides preset). 0=top-down, 30=high, 45=mid, 60=low, 90=side.
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

            <div className="border-t border-white/5 pt-3">
                <button
                    type="button"
                    onClick={() => setShowAdvanced(v => !v)}
                    className="w-full flex items-center justify-between text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                    <span>Style {projection === 'orthogonal' ? '(outline / shading / detail / seed)' : '(seed)'}</span>
                    <span className="text-zinc-600">{showAdvanced ? '−' : '+'}</span>
                </button>
                {showAdvanced && (
                    <div className="mt-2 flex flex-col gap-2">
                        {projection === 'orthogonal' && (
                            <>
                                <div>
                                    <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Outline</label>
                                    <input
                                        value={outline}
                                        onChange={e => setOutline(e.target.value)}
                                        placeholder='e.g. "thin black outline" or "no outline"'
                                        className="w-full bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Shading</label>
                                    <input
                                        value={shading}
                                        onChange={e => setShading(e.target.value)}
                                        placeholder='e.g. "soft shading" or "hard pillow"'
                                        className="w-full bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Detail</label>
                                    <input
                                        value={detail}
                                        onChange={e => setDetail(e.target.value)}
                                        placeholder='e.g. "low detail" or "high detail"'
                                        className="w-full bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50"
                                    />
                                </div>
                            </>
                        )}
                        <div>
                            <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Seed (optional)</label>
                            <input
                                type="number"
                                value={seedText}
                                onChange={e => setSeedText(e.target.value)}
                                placeholder="reproducible — same seed → same map"
                                className="w-full bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50"
                            />
                        </div>
                    </div>
                )}
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

// ── Tileset Tab ─────────────────────────────────────────────────────
//
// Shape-generic raw tile generation via PixelLab /create-tiles-pro. Returns
// N PNGs in the project file tree — no composed map. For non-isometric/non-
// Wang projections (hex / hex_pointy / octagon / square_topdown) the tiles
// are intended as raw assets the agent or the user can compose by hand.

const TILESET_SHAPES = [
    { id: 'hex' as const, label: 'Hex (flat)' },
    { id: 'hex_pointy' as const, label: 'Hex (pointy)' },
    { id: 'octagon' as const, label: 'Octagon' },
    { id: 'square_topdown' as const, label: 'Square top-down' },
    { id: 'isometric' as const, label: 'Isometric' },
];

function TilesetTab() {
    const { project, addConsoleEntry, refreshProjectFiles } = useEditorStore();

    const [prompt, setPrompt] = useState('');
    const [variantsText, setVariantsText] = useState('');
    const [shape, setShape] = useState<'hex' | 'hex_pointy' | 'octagon' | 'square_topdown' | 'isometric'>('hex');
    const [tileSize, setTileSize] = useState(32);
    const [tileHeight, setTileHeight] = useState('');
    const [tileView, setTileView] = useState<'top-down' | 'high top-down' | 'low top-down' | 'side'>('high top-down');
    const [tileViewAngle, setTileViewAngle] = useState('');
    const [depthRatio, setDepthRatio] = useState(0.5);
    const [seed, setSeed] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [resultPaths, setResultPaths] = useState<string[]>([]);

    const handleGenerate = async () => {
        if (!prompt.trim() || !project?.id) return;
        setBusy(true);
        setError(null);
        setResultPaths([]);

        const slug = prompt.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30) || 'tileset';
        const targetDir = `assets/tilesets/${shape}_${slug}`;
        const variantPrompts = variantsText.split('\n').map(s => s.trim()).filter(Boolean);

        addConsoleEntry({
            id: crypto.randomUUID(), level: 'log',
            message: `[Map Studio] Generating ${shape} tileset "${prompt}" (${tileSize}px)…`,
            timestamp: new Date().toISOString(),
        });

        try {
            const body: Record<string, unknown> = {
                action: 'generate_tileset',
                project_id: project.id,
                prompt: prompt.trim(),
                shape,
                tile_size: tileSize,
                target_dir: targetDir,
            };
            if (variantPrompts.length) body.variant_prompts = variantPrompts;
            const parsedHeight = parseInt(tileHeight, 10);
            if (Number.isFinite(parsedHeight) && parsedHeight >= 16 && parsedHeight <= 256) {
                body.tile_height = parsedHeight;
            }
            body.tile_view = tileView;
            const parsedAngle = parseFloat(tileViewAngle);
            if (Number.isFinite(parsedAngle) && parsedAngle >= 0 && parsedAngle <= 90) {
                body.tile_view_angle = parsedAngle;
            }
            // depth_ratio is meaningful for shapes with a vertical extent.
            if (shape === 'isometric' || shape === 'octagon') body.tile_depth_ratio = depthRatio;
            const parsedSeed = parseInt(seed, 10);
            if (Number.isFinite(parsedSeed)) body.seed = parsedSeed;

            const res = await fetch('/api/assets/map-action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                const msg = errorMessage(data.error, `Tileset failed (HTTP ${res.status})`);
                setError(msg);
                addConsoleEntry({ id: crypto.randomUUID(), level: 'error', message: `[Map Studio] Tileset failed: ${msg}`, timestamp: new Date().toISOString() });
                return;
            }
            const paths: string[] = data.tile_paths ?? [];
            setResultPaths(paths);
            refreshProjectFiles(project.id);
            addConsoleEntry({
                id: crypto.randomUUID(), level: 'log',
                message: `[Map Studio] Tileset → ${paths.length} tiles in ${targetDir}/ (~$${(data.cost ?? 0).toFixed(3)})`,
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Network error');
        } finally {
            setBusy(false);
        }
    };

    const showsDepth = shape === 'isometric' || shape === 'octagon';

    return (
        <div className="flex flex-col gap-3 p-3 overflow-y-auto flex-1">
            <div className="px-3 py-2 rounded-lg bg-cyan-500/5 border border-cyan-500/20 text-[11px] text-cyan-300/80 leading-relaxed">
                Generates raw tile PNGs in any shape. Unlike <b>Generate</b> this does <b>not</b> compose a final map — the tiles land in <code>assets/tilesets/…</code> for manual or agent-driven assembly.
            </div>

            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Theme</label>
                <textarea
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    rows={2}
                    placeholder='e.g. "enchanted forest"'
                    className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-cyan-500/50 transition-colors"
                />
            </div>

            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Shape</label>
                <div className="grid grid-cols-2 gap-1">
                    {TILESET_SHAPES.map(s => (
                        <button
                            key={s.id}
                            onClick={() => setShape(s.id)}
                            className={`py-1.5 rounded text-[11px] transition-colors ${
                                shape === s.id ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'
                            }`}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>
            </div>

            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Variants (one per line, up to 16)</label>
                <textarea
                    value={variantsText}
                    onChange={e => setVariantsText(e.target.value)}
                    rows={4}
                    placeholder={'grass\nforest floor\nmoss\nstone\nwater'}
                    className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-cyan-500/50 transition-colors"
                />
                <p className="text-[9px] text-zinc-600 mt-1">Leave blank to auto-derive 3 variants from theme.</p>
            </div>

            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Tile size — {tileSize}px</label>
                <div className="flex gap-1">
                    {TILE_SIZES.map(s => (
                        <button
                            key={s}
                            onClick={() => setTileSize(s)}
                            className={`flex-1 py-1 rounded text-xs transition-colors ${
                                tileSize === s ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'
                            }`}
                        >
                            {s}
                        </button>
                    ))}
                </div>
            </div>

            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">View angle</label>
                <div className="flex gap-1">
                    {(['top-down', 'high top-down', 'low top-down', 'side'] as const).map(v => (
                        <button
                            key={v}
                            onClick={() => setTileView(v)}
                            className={`flex-1 px-1.5 py-1 rounded text-[10px] transition-colors ${
                                tileView === v ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'
                            }`}
                        >
                            {v === 'top-down' ? 'Flat' : v === 'high top-down' ? 'High' : v === 'low top-down' ? 'Low' : 'Side'}
                        </button>
                    ))}
                </div>
            </div>

            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">
                    View angle override — <span className="normal-case text-zinc-600">{tileViewAngle.trim() ? `${tileViewAngle}°` : 'use preset'}</span>
                </label>
                <input
                    type="number"
                    min={0}
                    max={90}
                    value={tileViewAngle}
                    onChange={e => setTileViewAngle(e.target.value)}
                    placeholder="auto"
                    className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/50 transition-colors"
                />
            </div>

            {showsDepth && (
                <div>
                    <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">
                        Block height — {Math.round(depthRatio * 100)}%
                    </label>
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={depthRatio}
                        onChange={e => setDepthRatio(Number(e.target.value))}
                        className="w-full accent-cyan-500"
                    />
                </div>
            )}

            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">
                    Tile height (px) — <span className="normal-case text-zinc-600">{tileHeight.trim() ? `${tileHeight}px` : 'auto'}</span>
                </label>
                <input
                    type="number"
                    min={16}
                    max={256}
                    value={tileHeight}
                    onChange={e => setTileHeight(e.target.value)}
                    placeholder="auto"
                    className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/50 transition-colors"
                />
            </div>

            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Seed (optional)</label>
                <input
                    type="number"
                    value={seed}
                    onChange={e => setSeed(e.target.value)}
                    placeholder="reproducible"
                    className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-500/50 transition-colors"
                />
            </div>

            {error && <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">{error}</div>}

            <button
                onClick={handleGenerate}
                disabled={!prompt.trim() || busy}
                className="w-full py-2.5 rounded-lg font-medium text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed bg-gradient-to-r from-cyan-600 to-emerald-600 hover:from-cyan-500 hover:to-emerald-500 text-white shadow-lg shadow-cyan-500/20"
            >
                {busy ? <><Loader2 size={14} className="animate-spin" />Generating tileset…</> : <><Sparkles size={14} />Generate Tileset</>}
            </button>

            {resultPaths.length > 0 && (
                <div className="border-t border-white/5 pt-3">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Generated · {resultPaths.length} tiles</div>
                    <ul className="flex flex-col gap-1">
                        {resultPaths.map(p => (
                            <li key={p} className="text-[10px] font-mono text-zinc-400 truncate" title={p}>{p}</li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

// ── Layers Panel ────────────────────────────────────────────────────

const LAYER_KIND_COLORS: Record<LayerKind, string> = {
    terrain: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
    decoration: 'bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/20',
    collision: 'bg-red-500/10 text-red-300 border-red-500/20',
    overlay: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
};

function LayersPanel() {
    const meta = useMapEditorStore(s => s.metadata);
    const activeLayerId = useMapEditorStore(s => s.activeLayerId);
    const setActiveLayer = useMapEditorStore(s => s.setActiveLayer);
    const addLayer = useMapEditorStore(s => s.addLayer);
    const removeLayer = useMapEditorStore(s => s.removeLayer);
    const renameLayer = useMapEditorStore(s => s.renameLayer);
    const setLayerVisibility = useMapEditorStore(s => s.setLayerVisibility);
    const setLayerLocked = useMapEditorStore(s => s.setLayerLocked);
    const setLayerOpacity = useMapEditorStore(s => s.setLayerOpacity);
    const moveLayer = useMapEditorStore(s => s.moveLayer);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameDraft, setRenameDraft] = useState('');
    const [showAddMenu, setShowAddMenu] = useState(false);

    if (!meta) return null;
    const layers = meta.layers ?? [];
    // Top of the draw stack renders last, so show highest z_order first for
    // the familiar Photoshop/Tiled ordering.
    const sorted = [...layers].sort((a, b) => b.z_order - a.z_order);

    const placementCounts = new Map<string, number>();
    for (const p of meta.placements) {
        const id = p.layer_id ?? layers.find(l => l.kind === 'terrain')?.id ?? '';
        if (id) placementCounts.set(id, (placementCounts.get(id) ?? 0) + 1);
    }

    const startRename = (id: string, name: string) => {
        setRenamingId(id);
        setRenameDraft(name);
    };
    const commitRename = () => {
        if (renamingId && renameDraft.trim()) renameLayer(renamingId, renameDraft.trim());
        setRenamingId(null);
    };

    return (
        <div className="relative">
            <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] uppercase tracking-wider text-zinc-500">Layers · {layers.length}</label>
                <div className="relative">
                    <button
                        onClick={() => setShowAddMenu(v => !v)}
                        className="p-0.5 rounded hover:bg-white/5 text-zinc-400 hover:text-zinc-200 transition-colors"
                        title="Add layer"
                    >
                        <Plus size={12} />
                    </button>
                    {showAddMenu && (
                        <div
                            className="absolute right-0 top-full mt-1 z-10 bg-zinc-900 border border-white/10 rounded-md shadow-lg min-w-[120px] py-1"
                            onMouseLeave={() => setShowAddMenu(false)}
                        >
                            {(['decoration', 'collision', 'overlay'] as LayerKind[]).map(kind => (
                                <button
                                    key={kind}
                                    onClick={() => {
                                        addLayer(kind);
                                        setShowAddMenu(false);
                                    }}
                                    className="w-full px-2.5 py-1 text-left text-xs text-zinc-300 hover:bg-white/5 capitalize"
                                >
                                    {kind}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>
            <div className="flex flex-col gap-0.5 max-h-[220px] overflow-y-auto">
                {sorted.map(layer => {
                    const isActive = layer.id === activeLayerId;
                    const isTerrain = layer.kind === 'terrain';
                    const count = placementCounts.get(layer.id) ?? 0;
                    return (
                        <div
                            key={layer.id}
                            onClick={() => setActiveLayer(layer.id)}
                            className={`group flex items-center gap-1 px-1.5 py-1 rounded border cursor-pointer transition-colors ${
                                isActive
                                    ? 'bg-violet-500/15 border-violet-500/40'
                                    : 'bg-zinc-900/60 border-white/5 hover:border-white/10'
                            }`}
                        >
                            <button
                                onClick={(e) => { e.stopPropagation(); setLayerVisibility(layer.id, !layer.visible); }}
                                className="p-0.5 rounded hover:bg-white/5 text-zinc-400 hover:text-zinc-200 transition-colors flex-shrink-0"
                                title={layer.visible ? 'Hide' : 'Show'}
                            >
                                {layer.visible ? <Eye size={11} /> : <EyeOff size={11} className="opacity-50" />}
                            </button>
                            <button
                                onClick={(e) => { e.stopPropagation(); setLayerLocked(layer.id, !layer.locked); }}
                                className="p-0.5 rounded hover:bg-white/5 text-zinc-400 hover:text-zinc-200 transition-colors flex-shrink-0"
                                title={layer.locked ? 'Unlock' : 'Lock'}
                            >
                                {layer.locked ? <Lock size={11} className="text-amber-400" /> : <Unlock size={11} className="opacity-50" />}
                            </button>
                            <div className="flex-1 min-w-0">
                                {renamingId === layer.id ? (
                                    <input
                                        autoFocus
                                        value={renameDraft}
                                        onChange={e => setRenameDraft(e.target.value)}
                                        onBlur={commitRename}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') commitRename();
                                            if (e.key === 'Escape') setRenamingId(null);
                                        }}
                                        onClick={e => e.stopPropagation()}
                                        className="w-full bg-zinc-800 border border-white/10 rounded px-1 py-0.5 text-[11px] text-zinc-100 focus:outline-none focus:border-violet-500/50"
                                    />
                                ) : (
                                    <div
                                        className="text-[11px] text-zinc-200 truncate"
                                        onDoubleClick={(e) => { e.stopPropagation(); startRename(layer.id, layer.name); }}
                                        title="Double-click to rename"
                                    >
                                        {layer.name}
                                    </div>
                                )}
                                <div className="flex items-center gap-1 mt-0.5">
                                    <span className={`text-[8px] px-1 py-[1px] rounded border ${LAYER_KIND_COLORS[layer.kind]}`}>
                                        {layer.kind}
                                    </span>
                                    <span className="text-[8px] text-zinc-600">{count} placements</span>
                                </div>
                            </div>
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                                <button
                                    onClick={(e) => { e.stopPropagation(); moveLayer(layer.id, 'up'); }}
                                    className="p-0.5 rounded hover:bg-white/5 text-zinc-400 hover:text-zinc-200"
                                    title="Move up (draw on top)"
                                >
                                    <ArrowUp size={10} />
                                </button>
                                <button
                                    onClick={(e) => { e.stopPropagation(); moveLayer(layer.id, 'down'); }}
                                    className="p-0.5 rounded hover:bg-white/5 text-zinc-400 hover:text-zinc-200"
                                    title="Move down"
                                >
                                    <ArrowDown size={10} />
                                </button>
                                <button
                                    onClick={(e) => { e.stopPropagation(); startRename(layer.id, layer.name); }}
                                    className="p-0.5 rounded hover:bg-white/5 text-zinc-400 hover:text-zinc-200"
                                    title="Rename"
                                >
                                    <Pencil size={10} />
                                </button>
                                {!isTerrain && (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); if (confirm(`Delete layer "${layer.name}"? Its ${count} placements will move to the base layer.`)) removeLayer(layer.id); }}
                                        className="p-0.5 rounded hover:bg-red-500/10 text-zinc-500 hover:text-red-400"
                                        title="Delete"
                                    >
                                        <Trash2 size={10} />
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
            {(() => {
                const activeLayer = layers.find(l => l.id === activeLayerId);
                if (!activeLayer) return null;
                return (
                    <div className="mt-1.5 px-1.5">
                        <label className="text-[9px] uppercase tracking-wider text-zinc-500 flex items-center justify-between">
                            <span>Opacity · {activeLayer.name}</span>
                            <span className="text-zinc-400">{Math.round(activeLayer.opacity * 100)}%</span>
                        </label>
                        <input
                            type="range"
                            min={0}
                            max={100}
                            value={Math.round(activeLayer.opacity * 100)}
                            onChange={e => setLayerOpacity(activeLayer.id, Number(e.target.value) / 100)}
                            className="w-full accent-violet-500 mt-0.5"
                        />
                    </div>
                );
            })()}
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
        ] : [
            { id: 'inpaint' as MapTool, icon: Wand2, label: 'Inpaint' },
        ]),
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

            {/* Layers */}
            <LayersPanel />

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

type Tab = 'generate' | 'tileset' | 'edit' | 'gallery';

const TABS: { id: Tab; label: string; icon: typeof Wand2 }[] = [
    { id: 'generate', label: 'Generate', icon: Wand2 },
    { id: 'tileset', label: 'Tileset', icon: Grid3X3 },
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
            {tab === 'tileset' && <TilesetTab />}
            {tab === 'edit' && <EditTab />}
            {tab === 'gallery' && <MapsGalleryTab />}
        </div>
    );
}
