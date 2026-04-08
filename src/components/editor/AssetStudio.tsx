'use client';

import { useState, useRef, useCallback } from 'react';
import { useEditorStore } from '@/lib/store';
import type { AssetType, AssetStyle } from '@/types/asset';
import type { FreeAssetResult } from '@/lib/assets/search';
import {
    Sparkles,
    Image as ImageIcon,
    Grid3X3,
    Download,
    FolderPlus,
    Trash2,
    Loader2,
    Wand2,
    Search,
    ExternalLink,
    Check,
    X,
    Upload,
    Link,
    Film,
} from 'lucide-react';

// ── Tab Navigation ───────────────────────────────────────────────────

const TABS = [
    { id: 'generate' as const, label: 'Generate', icon: Wand2 },
    { id: 'gallery' as const, label: 'Gallery', icon: Grid3X3 },
];

// ── Generate Tab ─────────────────────────────────────────────────────

const ASSET_TYPES: { value: AssetType; label: string }[] = [
    { value: 'sprite', label: 'Sprite' },
    { value: 'sprite_sheet', label: 'Sprite Sheet' },
    { value: 'texture', label: 'Texture' },
    { value: 'ui_element', label: 'UI Element' },
    { value: 'model_3d', label: '3D Model' },
];

const STYLES: { value: AssetStyle; label: string }[] = [
    { value: 'pixel_art', label: 'Pixel Art' },
    { value: 'stylized', label: 'Stylized' },
    { value: 'hand_drawn', label: 'Hand Drawn' },
    { value: 'vector', label: 'Vector' },
    { value: 'realistic', label: 'Realistic' },
    { value: 'low_poly', label: 'Low Poly' },
];

const SIZE_PRESETS = [
    { label: '64', w: 64, h: 64 },
    { label: '128', w: 128, h: 128 },
    { label: '256', w: 256, h: 256 },
    { label: '512', w: 512, h: 512 },
];

// ── Model & Pricing Info ─────────────────────────────────────────────

type ProviderChoice = 'fal' | 'replicate';
type Model2DChoice = 'sdxl' | 'flux-schnell' | 'flux-dev';
type Model3DChoice = 'trellis' | 'hunyuan3d';

const PROVIDERS: { value: ProviderChoice; label: string; envHint: string }[] = [
    { value: 'fal',       label: 'fal.ai',     envHint: 'FAL_KEY' },
    { value: 'replicate', label: 'Replicate',   envHint: 'REPLICATE_API_TOKEN' },
];

const MODELS_2D: Record<ProviderChoice, { value: Model2DChoice; label: string; cost: string; desc: string }[]> = {
    fal: [
        { value: 'sdxl',         label: 'SDXL',         cost: 'Free',    desc: 'Fast, good quality' },
        { value: 'flux-schnell', label: 'Flux Schnell',  cost: '$0.003',  desc: 'Best value' },
        { value: 'flux-dev',     label: 'Flux Dev',      cost: '$0.025',  desc: 'Highest quality' },
    ],
    replicate: [
        { value: 'sdxl',         label: 'SDXL',         cost: '$0.005',  desc: 'Fast, good quality' },
        { value: 'flux-schnell', label: 'Flux Schnell',  cost: '$0.003',  desc: 'Best value' },
        { value: 'flux-dev',     label: 'Flux Dev',      cost: '$0.025',  desc: 'Highest quality' },
    ],
};

const MODELS_3D: Record<ProviderChoice, { value: Model3DChoice; label: string; cost: string; desc: string }[]> = {
    fal: [
        { value: 'trellis',   label: 'Trellis',      cost: '$0.02',  desc: 'Fast, cheap' },
        { value: 'hunyuan3d', label: 'Hunyuan3D v3', cost: '$0.375', desc: 'High quality' },
    ],
    replicate: [
        { value: 'hunyuan3d', label: 'Hunyuan3D v2', cost: '$0.18',  desc: 'High quality' },
    ],
};

// ── LoRA Input (URL or File Upload) ──────────────────────────────────

function LoraInput({
    loraUrl, setLoraUrl, loraScale, setLoraScale,
}: {
    loraUrl: string; setLoraUrl: (v: string) => void;
    loraScale: number; setLoraScale: (v: number) => void;
}) {
    const [mode, setMode] = useState<'url' | 'upload'>('upload');
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [uploadedName, setUploadedName] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    const handleFile = async (file: File) => {
        if (!file.name.endsWith('.safetensors')) {
            setError('Only .safetensors files are supported');
            return;
        }
        if (file.size > 500 * 1024 * 1024) {
            setError('File too large (max 500MB)');
            return;
        }
        setUploading(true);
        setUploadProgress(0);
        setError(null);
        try {
            // Step 1: Initialize chunked upload (tiny JSON)
            const initRes = await fetch('/api/assets/lora', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'init', filename: file.name, size: file.size }),
            });
            const initData = await initRes.json();
            if (!initRes.ok || !initData.success) {
                setError(initData.error || 'Failed to initialize upload');
                return;
            }

            const { uploadId, chunkSize, totalChunks } = initData;

            // Step 2: Send chunks (5MB each) via PUT
            for (let i = 0; i < totalChunks; i++) {
                const start = i * chunkSize;
                const end = Math.min(start + chunkSize, file.size);
                const chunk = file.slice(start, end);

                const chunkRes = await fetch('/api/assets/lora', {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'X-Upload-Id': uploadId,
                        'X-Chunk-Index': String(i),
                    },
                    body: chunk,
                });

                if (!chunkRes.ok) {
                    const err = await chunkRes.json().catch(() => ({ error: 'Chunk failed' }));
                    setError(err.error || `Chunk ${i + 1} failed`);
                    return;
                }

                setUploadProgress(Math.round(((i + 1) / totalChunks) * 85));
            }

            // Step 3: Complete — server assembles chunks and uploads to Supabase via TUS
            setUploadProgress(90);
            const completeRes = await fetch('/api/assets/lora', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'complete', uploadId, filename: file.name }),
            });
            const completeData = await completeRes.json();

            if (!completeRes.ok || !completeData.success) {
                setError(completeData.error || 'Failed to finalize upload');
                return;
            }

            setUploadProgress(100);
            setLoraUrl(completeData.url);
            setUploadedName(completeData.name);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Upload failed');
        } finally {
            setUploading(false);
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
    };

    const clear = () => {
        setLoraUrl('');
        setUploadedName(null);
        setError(null);
        if (fileRef.current) fileRef.current.value = '';
    };

    return (
        <div>
            <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] uppercase tracking-wider text-zinc-500">LoRA (optional)</label>
                <div className="flex gap-0.5">
                    <button
                        onClick={() => { setMode('upload'); clear(); }}
                        className={`p-1 rounded transition-colors ${mode === 'upload' ? 'text-violet-400 bg-violet-500/10' : 'text-zinc-600 hover:text-zinc-400'}`}
                        title="Upload file"
                    >
                        <Upload size={11} />
                    </button>
                    <button
                        onClick={() => { setMode('url'); clear(); }}
                        className={`p-1 rounded transition-colors ${mode === 'url' ? 'text-violet-400 bg-violet-500/10' : 'text-zinc-600 hover:text-zinc-400'}`}
                        title="Paste URL"
                    >
                        <Link size={11} />
                    </button>
                </div>
            </div>

            {mode === 'url' ? (
                <input
                    type="text"
                    value={loraUrl}
                    onChange={(e) => setLoraUrl(e.target.value)}
                    placeholder="https://huggingface.co/... or .safetensors URL"
                    className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50 transition-colors"
                />
            ) : uploadedName ? (
                <div className="flex items-center gap-2 bg-zinc-900 border border-emerald-500/20 rounded-lg px-3 py-1.5">
                    <Check size={12} className="text-emerald-400 flex-shrink-0" />
                    <span className="text-xs text-emerald-300 truncate flex-1">{uploadedName}</span>
                    <button onClick={clear} className="text-zinc-500 hover:text-zinc-300 flex-shrink-0"><X size={12} /></button>
                </div>
            ) : (
                <div
                    onClick={() => !uploading && fileRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleDrop}
                    className={`flex flex-col items-center gap-1 py-3 rounded-lg border border-dashed bg-zinc-900/50 transition-colors ${uploading ? 'border-violet-500/30' : 'border-white/10 cursor-pointer hover:border-violet-500/30'}`}
                >
                    {uploading ? (
                        <Loader2 size={16} className="text-violet-400 animate-spin" />
                    ) : (
                        <Upload size={16} className="text-zinc-600" />
                    )}
                    <span className="text-[10px] text-zinc-500">
                        {uploading ? `Uploading... ${uploadProgress}%` : 'Drop .safetensors or click to browse'}
                    </span>
                    {uploading && (
                        <div className="w-3/4 h-1 bg-zinc-800 rounded-full overflow-hidden mt-0.5">
                            <div className="h-full bg-violet-500 rounded-full transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
                        </div>
                    )}
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".safetensors"
                        className="hidden"
                        onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }}
                    />
                </div>
            )}

            {error && <p className="text-[10px] text-red-400 mt-1">{error}</p>}

            {/* Scale slider — show when a LoRA is active */}
            {loraUrl && (
                <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-[10px] text-zinc-500 w-10">Scale</span>
                    <input
                        type="range"
                        min={0} max={2} step={0.05}
                        value={loraScale}
                        onChange={(e) => setLoraScale(Number(e.target.value))}
                        className="flex-1 h-1 accent-violet-500"
                    />
                    <span className="text-[10px] text-zinc-400 font-mono w-7 text-right">{loraScale.toFixed(2)}</span>
                </div>
            )}
        </div>
    );
}

function GenerateTab() {
    const { project, assetGenerating, setAssetGenerating, addConsoleEntry, addAsset, setAssetStudioTab, setPreviewAssetId, refreshProjectFiles } = useEditorStore();
    const [prompt, setPrompt] = useState('');
    const [assetType, setAssetType] = useState<AssetType>('sprite');
    const [style, setStyle] = useState<AssetStyle>('pixel_art');
    const [sizeIdx, setSizeIdx] = useState(1); // 128x128 default
    const [transparentBg, setTransparentBg] = useState(true);
    const [frameCount, setFrameCount] = useState(4);
    const [provider, setProvider] = useState<ProviderChoice>('replicate');
    const [model2d, setModel2d] = useState<Model2DChoice>('flux-schnell');
    const [model3d, setModel3d] = useState<Model3DChoice>('trellis');
    const [loraUrl, setLoraUrl] = useState('');
    const [loraScale, setLoraScale] = useState(1.0);
    const [genError, setGenError] = useState<string | null>(null);
    const [lastCost, setLastCost] = useState<number | null>(null);

    const size = SIZE_PRESETS[sizeIdx];
    const isSheet = assetType === 'sprite_sheet';
    const is3D = assetType === 'model_3d';

    const handleGenerate = async () => {
        if (!prompt.trim() || !project?.id) return;
        setAssetGenerating(true);
        setGenError(null);
        setLastCost(null);

        const safeName = prompt.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
        const ext = is3D ? 'glb' : 'png';
        const targetPath = `assets/${safeName}.${ext}`;

        addConsoleEntry({
            id: crypto.randomUUID(), level: 'log',
            message: `[Asset Studio] Generating "${prompt}" (${assetType}, ${is3D ? model3d : model2d})...`,
            timestamp: new Date().toISOString(),
        });

        try {
            const res = await fetch('/api/assets/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project_id: project.id,
                    prompt: prompt.trim(),
                    asset_type: assetType,
                    style,
                    target_path: targetPath,
                    options: {
                        width: size.w,
                        height: size.h,
                        transparent_bg: transparentBg,
                        frame_count: isSheet ? frameCount : undefined,
                        model_2d: is3D ? undefined : model2d,
                        model_3d: is3D ? model3d : undefined,
                        provider,
                        loras: loraUrl.trim() ? [{ url: loraUrl.trim(), scale: loraScale }] : undefined,
                    },
                }),
            });

            const data = await res.json();

            if (res.ok && data.success) {
                setLastCost(data.credits_used);
                addConsoleEntry({
                    id: crypto.randomUUID(), level: 'log',
                    message: `[Asset Studio] Generated "${prompt}" → ${targetPath} (${data.credits_used} credits)`,
                    timestamp: new Date().toISOString(),
                });
                const assetId = crypto.randomUUID();
                addAsset({
                    id: assetId,
                    project_id: project.id,
                    name: `${prompt.trim().slice(0, 40)}`,
                    asset_type: assetType,
                    storage_key: data.storage_key || targetPath,
                    thumbnail_key: null,
                    file_format: ext,
                    width: is3D ? null : size.w,
                    height: is3D ? null : size.h,
                    metadata: { tags: [style, is3D ? model3d : model2d] },
                    generation_prompt: prompt.trim(),
                    generation_model: is3D ? model3d : model2d,
                    size_bytes: 0,
                    created_at: new Date().toISOString(),
                });
                setPreviewAssetId(assetId);
                refreshProjectFiles(project.id);
                setAssetStudioTab('gallery');
            } else {
                setGenError(data.error || 'Generation failed');
                addConsoleEntry({
                    id: crypto.randomUUID(), level: 'error',
                    message: `[Asset Studio] Failed: ${data.error}`,
                    timestamp: new Date().toISOString(),
                });
            }
        } catch {
            setGenError('Network error — check your connection');
        } finally {
            setAssetGenerating(false);
        }
    };

    return (
        <div className="flex flex-col gap-3 p-3 overflow-y-auto flex-1">
            {/* Prompt */}
            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Prompt</label>
                <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="A warrior character with sword and shield, side view..."
                    className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-violet-500/50 transition-colors"
                    rows={3}
                />
            </div>

            {/* Asset Type */}
            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Type</label>
                <div className="flex flex-wrap gap-1">
                    {ASSET_TYPES.map((t) => (
                        <button
                            key={t.value}
                            onClick={() => setAssetType(t.value)}
                            className={`px-2 py-1 rounded text-xs transition-colors ${
                                assetType === t.value
                                    ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                                    : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'
                            }`}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Style */}
            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Style</label>
                <div className="flex flex-wrap gap-1">
                    {STYLES.map((s) => (
                        <button
                            key={s.value}
                            onClick={() => setStyle(s.value)}
                            className={`px-2 py-1 rounded text-xs transition-colors ${
                                style === s.value
                                    ? 'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30'
                                    : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'
                            }`}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Size */}
            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">
                    Size — {size.w}x{size.h}px
                </label>
                <div className="flex gap-1">
                    {SIZE_PRESETS.map((p, i) => (
                        <button
                            key={p.label}
                            onClick={() => setSizeIdx(i)}
                            className={`flex-1 py-1 rounded text-xs transition-colors ${
                                sizeIdx === i
                                    ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                                    : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'
                            }`}
                        >
                            {p.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Options row */}
            <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={transparentBg}
                        onChange={(e) => setTransparentBg(e.target.checked)}
                        className="rounded bg-zinc-900 border-white/10 text-violet-500 focus:ring-violet-500/30 w-3.5 h-3.5"
                    />
                    Transparent
                </label>
                {isSheet && (
                    <div className="flex items-center gap-1.5">
                        <span className="text-xs text-zinc-500">Frames:</span>
                        <input
                            type="number"
                            min={2}
                            max={32}
                            value={frameCount}
                            onChange={(e) => setFrameCount(Number(e.target.value))}
                            className="w-12 bg-zinc-900 border border-white/10 rounded px-1.5 py-0.5 text-xs text-zinc-200 text-center focus:outline-none focus:border-violet-500/50"
                        />
                    </div>
                )}
            </div>

            {/* LoRA (2D only) */}
            {!is3D && <LoraInput loraUrl={loraUrl} setLoraUrl={setLoraUrl} loraScale={loraScale} setLoraScale={setLoraScale} />}

            {/* Provider + AI Model Selection */}
            <div>
                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">Provider</label>
                <div className="flex gap-1 mb-2">
                    {PROVIDERS.map((p) => (
                        <button
                            key={p.value}
                            onClick={() => {
                                setProvider(p.value);
                                // Reset 3D model if switching to replicate (no Trellis)
                                if (p.value === 'replicate' && model3d === 'trellis') setModel3d('hunyuan3d');
                            }}
                            className={`flex-1 py-1 rounded text-xs transition-colors ${
                                provider === p.value
                                    ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                                    : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'
                            }`}
                        >
                            {p.label}
                        </button>
                    ))}
                </div>

                <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">
                    {is3D ? '3D Model' : '2D Model'}
                </label>
                <div className="flex flex-col gap-1">
                    {(is3D ? MODELS_3D[provider] : MODELS_2D[provider]).map((m) => (
                        <button
                            key={m.value}
                            onClick={() => is3D ? setModel3d(m.value as Model3DChoice) : setModel2d(m.value as Model2DChoice)}
                            className={`flex items-center justify-between px-2.5 py-1.5 rounded text-xs transition-colors ${
                                (is3D ? model3d : model2d) === m.value
                                    ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                                    : 'bg-zinc-900 text-zinc-500 border border-white/5 hover:text-zinc-300'
                            }`}
                        >
                            <span className="font-medium">{m.label}</span>
                            <span className="flex items-center gap-2">
                                <span className="text-zinc-600">{m.desc}</span>
                                <span className={`font-mono ${m.cost === 'Free' ? 'text-emerald-400' : 'text-amber-400'}`}>
                                    {m.cost}
                                </span>
                            </span>
                        </button>
                    ))}
                </div>
            </div>

            {/* Error / Cost display */}
            {genError && (
                <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
                    {genError}
                </div>
            )}
            {lastCost !== null && (
                <div className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs text-center">
                    Generated — {lastCost} credits used
                </div>
            )}

            {/* Generate Button */}
            <button
                onClick={handleGenerate}
                disabled={!prompt.trim() || assetGenerating}
                className="w-full py-2.5 rounded-lg font-medium text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white shadow-lg shadow-violet-500/20"
            >
                {assetGenerating ? (
                    <>
                        <Loader2 size={14} className="animate-spin" />
                        Generating...
                    </>
                ) : (
                    <>
                        <Sparkles size={14} />
                        Generate Asset
                    </>
                )}
            </button>

            {/* Free Asset Search */}
            <FreeAssetSearch />
        </div>
    );
}

// ── Free Asset Search ────────────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
    Kenney: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    OpenGameArt: 'text-sky-400 bg-sky-500/10 border-sky-500/20',
    'itch.io': 'text-rose-400 bg-rose-500/10 border-rose-500/20',
};

type ImportStatus = 'idle' | 'importing' | 'success' | 'error';
interface ResultState { status: ImportStatus; error?: string; path?: string; sizeKb?: number; fileCount?: number }

function FreeAssetSearch() {
    const { project, addConsoleEntry, addAsset, refreshProjectFiles, setAssetStudioTab } = useEditorStore();
    const [searchQuery, setSearchQuery] = useState('');
    const [searching, setSearching] = useState(false);
    const [results, setResults] = useState<FreeAssetResult[]>([]);
    const [hasSearched, setHasSearched] = useState(false);
    const [importStates, setImportStates] = useState<Record<string, ResultState>>({});
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const resultKey = (r: FreeAssetResult, i: number) => `${r.source}-${r.title}-${i}`;

    const doSearch = useCallback(async (query: string) => {
        if (!query.trim()) { setResults([]); setHasSearched(false); return; }
        setSearching(true);
        setHasSearched(true);
        setImportStates({});
        try {
            const params = new URLSearchParams({ q: query.trim(), type: 'sprite' });
            const res = await fetch(`/api/assets/search?${params}`);
            if (res.ok) {
                const data = await res.json();
                setResults(data.results ?? []);
            }
        } catch { /* network error */ }
        setSearching(false);
    }, []);

    const handleImport = useCallback(async (result: FreeAssetResult, idx: number) => {
        if (!project?.id) return;
        const key = resultKey(result, idx);
        if (importStates[key]?.status === 'importing' || importStates[key]?.status === 'success') return;

        const safeName = result.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
        const targetPath = `assets/${safeName}.png`;

        setImportStates(prev => ({ ...prev, [key]: { status: 'importing' } }));

        try {
            const res = await fetch('/api/assets/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project_id: project.id,
                    download_url: result.download_url,
                    preview_url: result.preview_url,
                    page_url: result.url,
                    target_path: targetPath,
                    title: result.title,
                    source: result.source,
                }),
            });
            const data = await res.json();
            if (res.ok && data.success) {
                if (data.pack && data.files) {
                    // ZIP pack — multiple files extracted
                    const totalKb = Math.round(data.files.reduce((s: number, f: { size_bytes: number }) => s + f.size_bytes, 0) / 1024);
                    setImportStates(prev => ({
                        ...prev,
                        [key]: { status: 'success', path: `${data.files_imported} files`, sizeKb: totalKb, fileCount: data.files_imported },
                    }));
                    addConsoleEntry({
                        id: crypto.randomUUID(), level: 'log',
                        message: `[Asset Studio] Imported pack "${result.title}" — ${data.files_imported} files (${totalKb}KB)`,
                        timestamp: new Date().toISOString(),
                    });
                    // Add each extracted file to gallery
                    for (const f of data.files) {
                        const fileName = f.path.split('/').pop() || f.path;
                        addAsset({
                            id: crypto.randomUUID(),
                            project_id: project.id,
                            name: fileName,
                            asset_type: 'sprite',
                            storage_key: f.path,
                            thumbnail_key: f.public_url || null,
                            file_format: fileName.split('.').pop() || 'png',
                            width: null, height: null,
                            metadata: { tags: [result.source, result.license, result.title] },
                            generation_prompt: null,
                            generation_model: null,
                            size_bytes: f.size_bytes,
                            created_at: new Date().toISOString(),
                        });
                    }
                } else {
                    // Single file
                    const sizeKb = Math.round(data.size_bytes / 1024);
                    setImportStates(prev => ({ ...prev, [key]: { status: 'success', path: targetPath, sizeKb } }));
                    addConsoleEntry({
                        id: crypto.randomUUID(), level: 'log',
                        message: `[Asset Studio] Imported "${result.title}" → ${targetPath} (${sizeKb}KB)`,
                        timestamp: new Date().toISOString(),
                    });
                    addAsset({
                        id: crypto.randomUUID(),
                        project_id: project.id,
                        name: result.title,
                        asset_type: 'sprite',
                        storage_key: data.storage_key,
                        thumbnail_key: data.public_url || null,
                        file_format: 'png',
                        width: null, height: null,
                        metadata: { tags: [result.source, result.license] },
                        generation_prompt: null,
                        generation_model: null,
                        size_bytes: data.size_bytes,
                        created_at: new Date().toISOString(),
                    });
                }
                refreshProjectFiles(project.id);
            } else {
                setImportStates(prev => ({ ...prev, [key]: { status: 'error', error: data.error } }));
                addConsoleEntry({
                    id: crypto.randomUUID(), level: 'error',
                    message: `[Asset Studio] Failed: ${data.error}`,
                    timestamp: new Date().toISOString(),
                });
            }
        } catch {
            setImportStates(prev => ({ ...prev, [key]: { status: 'error', error: 'Network error' } }));
        }
    }, [project, importStates, addConsoleEntry, addAsset, refreshProjectFiles]);

    const handleInput = (value: string) => {
        setSearchQuery(value);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => doSearch(value), 400);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            doSearch(searchQuery);
        }
    };

    const importedCount = Object.values(importStates).filter(s => s.status === 'success').length;

    return (
        <div className="pt-2 border-t border-white/5">
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 block">
                Or search free assets
            </label>
            <div className="relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
                {searching && (
                    <Loader2 size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-violet-400 animate-spin" />
                )}
                <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => handleInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Search Kenney, OpenGameArt, itch.io..."
                    className="w-full bg-zinc-900 border border-white/10 rounded-lg pl-7 pr-8 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50 transition-colors"
                />
            </div>

            {/* Imported count banner */}
            {importedCount > 0 && (
                <button
                    onClick={() => setAssetStudioTab('gallery')}
                    className="mt-2 w-full py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs flex items-center justify-center gap-1.5 hover:bg-emerald-500/20 transition-colors"
                >
                    <Check size={12} />
                    {importedCount} asset{importedCount > 1 ? 's' : ''} imported — View in Gallery
                </button>
            )}

            {/* Results */}
            {results.length > 0 && (
                <div className="mt-2 flex flex-col gap-1 max-h-[240px] overflow-y-auto">
                    {results.map((r, i) => {
                        const key = resultKey(r, i);
                        const state = importStates[key] ?? { status: 'idle' as ImportStatus };
                        const isSuccess = state.status === 'success';
                        const isError = state.status === 'error';
                        const isImporting = state.status === 'importing';

                        return (
                            <div
                                key={key}
                                className={`flex items-start gap-2 p-2 rounded-lg border transition-colors ${
                                    isSuccess
                                        ? 'bg-emerald-500/5 border-emerald-500/20'
                                        : isError
                                        ? 'bg-red-500/5 border-red-500/20'
                                        : 'bg-zinc-900/50 border-white/5 hover:border-white/10'
                                }`}
                            >
                                {/* Thumbnail */}
                                <div className="flex-shrink-0 w-10 h-10 rounded bg-zinc-800 border border-white/5 flex items-center justify-center overflow-hidden">
                                    {isSuccess ? (
                                        <Check size={16} className="text-emerald-400" />
                                    ) : (
                                        <ImageIcon size={14} className="text-zinc-600" />
                                    )}
                                </div>

                                {/* Info */}
                                <div className="flex-1 min-w-0">
                                    <span className="text-xs text-zinc-200 truncate font-medium block">
                                        {r.title}
                                    </span>
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${SOURCE_COLORS[r.source] ?? 'text-zinc-400 bg-zinc-800 border-zinc-700'}`}>
                                            {r.source}
                                        </span>
                                        <span className="text-[9px] text-zinc-600 truncate">
                                            {r.license}
                                        </span>
                                    </div>
                                    {/* Status messages */}
                                    {isSuccess && (
                                        <span className="text-[10px] text-emerald-400 mt-0.5 block">
                                            {state.fileCount
                                                ? `${state.fileCount} sprites imported (${state.sizeKb}KB)`
                                                : `Imported to ${state.path} (${state.sizeKb}KB)`
                                            }
                                        </span>
                                    )}
                                    {isError && (
                                        <span className="text-[10px] text-red-400 mt-0.5 block truncate">
                                            {state.error}
                                        </span>
                                    )}
                                </div>

                                {/* Actions */}
                                <div className="flex-shrink-0 flex gap-1">
                                    <a
                                        href={r.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                                        title="View on source"
                                    >
                                        <ExternalLink size={12} />
                                    </a>
                                    {isSuccess ? (
                                        <span className="p-1 text-emerald-400"><Check size={12} /></span>
                                    ) : isError ? (
                                        <button
                                            onClick={() => handleImport(r, i)}
                                            className="p-1 rounded text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                                            title="Retry import"
                                        >
                                            <X size={12} />
                                        </button>
                                    ) : (
                                        <button
                                            onClick={() => handleImport(r, i)}
                                            disabled={isImporting}
                                            className="p-1 rounded text-violet-400 hover:text-violet-300 hover:bg-violet-500/10 transition-colors disabled:opacity-40"
                                            title="Import to project"
                                        >
                                            {isImporting ? (
                                                <Loader2 size={12} className="animate-spin" />
                                            ) : (
                                                <FolderPlus size={12} />
                                            )}
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Empty state */}
            {hasSearched && !searching && results.length === 0 && (
                <div className="mt-2 text-center py-3 text-xs text-zinc-600">
                    No results for &quot;{searchQuery}&quot;
                </div>
            )}
        </div>
    );
}

// ── Gallery Tab ──────────────────────────────────────────────────────


function GalleryTab() {
    const { assets, project, previewAssetId, setPreviewAssetId, addAsset, removeAsset, addConsoleEntry, refreshProjectFiles, setAssetGenerating, assetGenerating } = useEditorStore();
    const [animating, setAnimating] = useState(false);
    const [animFrames, setAnimFrames] = useState(6);
    const [animPrompt, setAnimPrompt] = useState('');
    const [animError, setAnimError] = useState('');
    const [showAnimPanel, setShowAnimPanel] = useState(false);

    const selectedAsset = assets.find(a => a.id === previewAssetId);

    /** Extract N frames from video at native resolution, assemble into sprite sheet. */
    const extractFrames = useCallback(async (videoUrl: string, frameCount: number): Promise<{ blob: Blob; frameW: number; frameH: number }> => {
        const videoRes = await fetch(videoUrl);
        const videoBlob = await videoRes.blob();
        const localUrl = URL.createObjectURL(videoBlob);

        try {
            return await new Promise<{ blob: Blob; frameW: number; frameH: number }>((resolve, reject) => {
                const video = document.createElement('video');
                video.muted = true;
                video.playsInline = true;
                video.src = localUrl;
                video.onloadedmetadata = async () => {
                    const vw = video.videoWidth;
                    const vh = video.videoHeight;
                    const canvas = document.createElement('canvas');
                    canvas.width = vw * frameCount;
                    canvas.height = vh;
                    const ctx = canvas.getContext('2d')!;
                    const duration = video.duration;
                    for (let i = 0; i < frameCount; i++) {
                        video.currentTime = i * duration / frameCount;
                        await new Promise<void>(r => { video.onseeked = () => r(); });
                        ctx.drawImage(video, i * vw, 0, vw, vh);
                    }
                    canvas.toBlob(blob => {
                        if (blob) resolve({ blob, frameW: vw, frameH: vh });
                        else reject(new Error('Failed to create sprite sheet'));
                    }, 'image/png');
                };
                video.onerror = () => reject(new Error('Failed to load video'));
                video.load();
            });
        } finally {
            URL.revokeObjectURL(localUrl);
        }
    }, []);

    const handleAnimate = async () => {
        if (!selectedAsset?.storage_key || !project?.id || !animPrompt.trim()) return;
        setAnimating(true);
        setAnimError('');
        setAssetGenerating(true);

        const sourceUrl = `${window.location.origin}/api/assets/serve?key=${encodeURIComponent(selectedAsset.storage_key)}`;
        const baseName = selectedAsset.name.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
        const promptSlug = animPrompt.trim().replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20);
        const targetPath = `assets/${baseName}_${promptSlug}_${animFrames}f.png`;

        addConsoleEntry({
            id: crypto.randomUUID(), level: 'log',
            message: `[Asset Studio] Generating animation video for "${selectedAsset.name}"...`,
            timestamp: new Date().toISOString(),
        });

        try {
            // Step 1: Generate video on server
            const res = await fetch('/api/assets/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project_id: project.id,
                    prompt: animPrompt.trim(),
                    asset_type: 'animation',
                    target_path: targetPath,
                    options: {
                        source_image_url: sourceUrl,
                        model_video: 'kling',
                    },
                }),
            });

            const data = await res.json();
            const videoUrl = (data.output as Record<string, unknown> | undefined)?.video_url as string | undefined;

            if (!res.ok || !data.success || !videoUrl) {
                setAnimError(data.error || 'Video generation failed');
                addConsoleEntry({ id: crypto.randomUUID(), level: 'error', message: `[Asset Studio] Video generation failed: ${data.error}`, timestamp: new Date().toISOString() });
                return;
            }

            addConsoleEntry({ id: crypto.randomUUID(), level: 'log', message: `[Asset Studio] Extracting ${animFrames} frames from video...`, timestamp: new Date().toISOString() });

            // Step 2: Extract frames client-side (native video resolution)
            const { blob: spriteBlob, frameW, frameH } = await extractFrames(videoUrl, animFrames);

            // Step 3: Upload sprite sheet to server
            const formData = new FormData();
            formData.append('file', spriteBlob, `${baseName}_spritesheet.png`);
            formData.append('project_id', project.id);
            formData.append('target_path', targetPath);

            const uploadRes = await fetch('/api/assets/upload', { method: 'POST', body: formData });
            const uploadData = await uploadRes.json();

            if (!uploadRes.ok || !uploadData.success) {
                setAnimError(uploadData.error || 'Sprite sheet upload failed');
                return;
            }

            // Step 4: Register asset in store
            const assetId = crypto.randomUUID();
            addAsset({
                id: assetId,
                project_id: project.id,
                name: `${selectedAsset.name} (${animPrompt.slice(0, 20)})`,
                asset_type: 'sprite_sheet',
                storage_key: uploadData.storage_key || targetPath,
                thumbnail_key: null,
                file_format: 'png',
                width: frameW * animFrames,
                height: frameH,
                metadata: {
                    tags: ['animation'],
                    frames: Array.from({ length: animFrames }, (_, i) => ({
                        x: i * frameW, y: 0, width: frameW, height: frameH, duration: 1,
                    })),
                    frameRate: 12,
                    loop: true,
                },
                generation_prompt: animPrompt.trim(),
                generation_model: (data.output as Record<string, unknown>)?.model_used as string || null,
                size_bytes: spriteBlob.size,
                created_at: new Date().toISOString(),
            });
            setPreviewAssetId(assetId);
            refreshProjectFiles(project.id);
            setShowAnimPanel(false);
            addConsoleEntry({ id: crypto.randomUUID(), level: 'log', message: `[Asset Studio] Animation complete → ${targetPath} (${animFrames} frames)`, timestamp: new Date().toISOString() });
        } catch (err) {
            setAnimError(err instanceof Error ? err.message : 'Animation failed');
        } finally {
            setAnimating(false);
            setAssetGenerating(false);
        }
    };

    if (assets.length === 0) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-600 p-6">
                <ImageIcon size={32} strokeWidth={1} />
                <p className="text-sm text-center">No assets yet</p>
                <p className="text-xs text-center text-zinc-700">
                    Generate sprites, textures, and models<br />
                    using the Generate tab
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col flex-1 overflow-hidden">
            {/* Grid */}
            <div className="flex-1 overflow-y-auto p-2">
                <div className="grid grid-cols-3 gap-1.5">
                    {assets.map((asset) => (
                        <button
                            key={asset.id}
                            onClick={() => { setPreviewAssetId(asset.id === previewAssetId ? null : asset.id); setShowAnimPanel(false); }}
                            className={`relative aspect-square rounded-lg overflow-hidden border transition-all ${
                                previewAssetId === asset.id
                                    ? 'border-violet-500 ring-1 ring-violet-500/30'
                                    : 'border-white/5 hover:border-white/10'
                            }`}
                        >
                            <div className="absolute inset-0 bg-[length:8px_8px] bg-[position:0_0,4px_4px] bg-[image:linear-gradient(45deg,#1a1a2e_25%,transparent_25%,transparent_75%,#1a1a2e_75%),linear-gradient(45deg,#1a1a2e_25%,transparent_25%,transparent_75%,#1a1a2e_75%)]" />
                            {asset.storage_key ? (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img
                                    src={`/api/assets/serve?key=${encodeURIComponent(asset.storage_key)}`}
                                    alt={asset.name}
                                    className="absolute inset-0 w-full h-full object-contain"
                                />
                            ) : (
                                <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/80">
                                    <ImageIcon size={16} className="text-zinc-600" />
                                </div>
                            )}
                            <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1">
                                <span className="text-[9px] text-zinc-300 truncate block">{asset.name}</span>
                            </div>
                        </button>
                    ))}
                </div>
            </div>

            {/* Animate panel */}
            {showAnimPanel && selectedAsset && (
                <div className="flex-shrink-0 border-t border-white/5 p-2 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] uppercase tracking-wider text-zinc-500">Animate &quot;{selectedAsset.name.slice(0, 20)}&quot;</span>
                        <button onClick={() => setShowAnimPanel(false)} className="text-zinc-500 hover:text-zinc-300"><X size={12} /></button>
                    </div>
                    <input
                        type="text"
                        value={animPrompt}
                        onChange={e => setAnimPrompt(e.target.value)}
                        placeholder="Describe the motion (e.g. walking forward, rocking on waves...)"
                        className="w-full px-2 py-1.5 rounded bg-zinc-800 border border-white/5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-violet-500/40"
                    />
                    <div className="flex items-center gap-2">
                        <label className="text-[10px] text-zinc-500 whitespace-nowrap">Frames</label>
                        <input
                            type="range" min={2} max={8} value={animFrames}
                            onChange={e => setAnimFrames(Number(e.target.value))}
                            className="flex-1 accent-violet-500 h-1"
                        />
                        <span className="text-xs text-zinc-400 w-4 text-center">{animFrames}</span>
                    </div>
                    {animError && <p className="text-[10px] text-red-400">{animError}</p>}
                    <button
                        onClick={handleAnimate}
                        disabled={animating || assetGenerating || !animPrompt.trim()}
                        className="w-full py-1.5 rounded bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white text-xs font-medium disabled:opacity-40 hover:brightness-110 transition-all flex items-center justify-center gap-1.5"
                    >
                        {animating ? (
                            <><Loader2 size={12} className="animate-spin" />Generating {animFrames} frames...</>
                        ) : (
                            <><Film size={12} />Generate Animation</>
                        )}
                    </button>
                </div>
            )}

            {/* Selected asset actions */}
            {previewAssetId && !showAnimPanel && (
                <div className="flex-shrink-0 border-t border-white/5 p-2 flex gap-1.5">
                    <button
                        onClick={() => { setShowAnimPanel(true); setAnimError(''); }}
                        className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded bg-violet-500/20 text-violet-300 text-xs hover:bg-violet-500/30 transition-colors"
                    >
                        <Film size={12} />
                        Animate
                    </button>
                    <button className="flex items-center justify-center gap-1 px-3 py-1.5 rounded bg-zinc-800 text-zinc-400 text-xs hover:bg-zinc-700 transition-colors">
                        <Download size={12} />
                    </button>
                    <button
                        onClick={() => { if (selectedAsset) { removeAsset(selectedAsset.id); } }}
                        className="flex items-center justify-center gap-1 px-3 py-1.5 rounded bg-zinc-800 text-red-400 text-xs hover:bg-red-500/20 transition-colors"
                    >
                        <Trash2 size={12} />
                    </button>
                </div>
            )}
        </div>
    );
}

// ── Main Component ───────────────────────────────────────────────────

export default function AssetStudio() {
    const { assetStudioTab, setAssetStudioTab, setActiveRightPanel } = useEditorStore();

    return (
        <div className="flex flex-col h-full bg-zinc-950">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center">
                        <Sparkles size={10} className="text-white" />
                    </div>
                    <span className="text-sm font-semibold text-zinc-200">Asset Studio</span>
                </div>
                <button
                    onClick={() => setActiveRightPanel('chat')}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 px-2 py-0.5 rounded hover:bg-white/5 transition-colors"
                >
                    Back to Chat
                </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-white/5">
                {TABS.map((tab) => {
                    const Icon = tab.icon;
                    return (
                        <button
                            key={tab.id}
                            onClick={() => setAssetStudioTab(tab.id)}
                            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs transition-colors ${
                                assetStudioTab === tab.id
                                    ? 'text-violet-400 border-b-2 border-violet-500 bg-violet-500/5'
                                    : 'text-zinc-500 hover:text-zinc-300'
                            }`}
                        >
                            <Icon size={12} />
                            {tab.label}
                        </button>
                    );
                })}
            </div>

            {/* Tab content */}
            {assetStudioTab === 'generate' && <GenerateTab />}
            {assetStudioTab === 'gallery' && <GalleryTab />}
        </div>
    );
}
