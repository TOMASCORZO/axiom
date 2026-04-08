'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useEditorStore } from '@/lib/store';
import type { Asset } from '@/types/asset';
import {
    Image as ImageIcon,
    ZoomIn,
    ZoomOut,
    Maximize2,
    X,
    ChevronLeft,
    ChevronRight,
    Film,
    Wand2,
    Loader2,
} from 'lucide-react';

const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

export default function AssetPreview() {
    const {
        assets, project, previewAssetId, setPreviewAssetId,
        addAsset, addConsoleEntry, refreshProjectFiles,
        setAssetGenerating, assetGenerating,
    } = useEditorStore();
    const asset = assets.find((a) => a.id === previewAssetId) ?? null;

    // Action panel state
    const [activeAction, setActiveAction] = useState<'animate' | 'img2img' | null>(null);
    const [actionBusy, setActionBusy] = useState(false);
    const [actionError, setActionError] = useState('');

    // Animate options
    const [animPrompt, setAnimPrompt] = useState('');
    const [animFrames, setAnimFrames] = useState(6);

    // Img2Img options
    const [img2imgPrompt, setImg2imgPrompt] = useState('');
    const [img2imgStrength, setImg2imgStrength] = useState(0.5);

    // Reset panel on asset change
    useEffect(() => {
        setActiveAction(null);
        setActionError('');
    }, [previewAssetId]);

    // Navigation between assets
    const currentIdx = asset ? assets.indexOf(asset) : -1;
    const hasPrev = currentIdx > 0;
    const hasNext = currentIdx >= 0 && currentIdx < assets.length - 1;

    const goPrev = () => { if (hasPrev) setPreviewAssetId(assets[currentIdx - 1].id); };
    const goNext = () => { if (hasNext) setPreviewAssetId(assets[currentIdx + 1].id); };

    /** Extract N frames from video at native resolution, assemble into sprite sheet. */
    const extractFrames = useCallback(async (videoUrl: string, frameCount: number): Promise<{ blob: Blob; frameW: number; frameH: number }> => {
        const videoRes = await fetch(`/api/assets/proxy-video?url=${encodeURIComponent(videoUrl)}`);
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
        } finally { URL.revokeObjectURL(localUrl); }
    }, []);

    // ── Animate handler ──
    const handleAnimate = async () => {
        if (!asset?.storage_key || !project?.id || !animPrompt.trim()) return;
        setActionBusy(true);
        setActionError('');
        setAssetGenerating(true);

        const sourceUrl = `${window.location.origin}/api/assets/serve?key=${encodeURIComponent(asset.storage_key)}`;
        const baseName = asset.name.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
        const promptSlug = animPrompt.trim().replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20);
        const targetPath = `assets/${baseName}_${promptSlug}_${animFrames}f.png`;

        addConsoleEntry({ id: crypto.randomUUID(), level: 'log', message: `[Asset Studio] Generating animation video for "${asset.name}"...`, timestamp: new Date().toISOString() });

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
                    options: { source_image_url: sourceUrl, model_video: 'kling' },
                }),
            });
            const data = await res.json();
            const videoUrl = (data.output as Record<string, unknown> | undefined)?.video_url as string | undefined;

            if (!res.ok || !data.success || !videoUrl) {
                setActionError(data.error || 'Video generation failed');
                return;
            }

            addConsoleEntry({ id: crypto.randomUUID(), level: 'log', message: `[Asset Studio] Extracting ${animFrames} frames from video...`, timestamp: new Date().toISOString() });

            // Step 2: Extract frames client-side (native video resolution)
            const { blob: spriteBlob, frameW, frameH } = await extractFrames(videoUrl, animFrames);

            // Step 3: Upload sprite sheet
            const formData = new FormData();
            formData.append('file', spriteBlob, `${baseName}_spritesheet.png`);
            formData.append('project_id', project.id);
            formData.append('target_path', targetPath);
            const uploadRes = await fetch('/api/assets/upload', { method: 'POST', body: formData });
            const uploadData = await uploadRes.json();

            if (!uploadRes.ok || !uploadData.success) {
                setActionError(uploadData.error || 'Sprite sheet upload failed');
                return;
            }

            // Step 4: Register asset
            const assetId = crypto.randomUUID();
            addAsset({
                id: assetId, project_id: project.id,
                name: `${asset.name} (${animPrompt.trim().slice(0, 20)})`, asset_type: 'sprite_sheet',
                storage_key: uploadData.storage_key || targetPath, thumbnail_key: null, file_format: 'png',
                width: frameW * animFrames, height: frameH,
                metadata: {
                    tags: ['animation'],
                    frames: Array.from({ length: animFrames }, (_, i) => ({ x: i * frameW, y: 0, width: frameW, height: frameH, duration: 1 })),
                    frameRate: 12, loop: true,
                },
                generation_prompt: animPrompt.trim(),
                generation_model: (data.output as Record<string, unknown>)?.model_used as string || null,
                size_bytes: spriteBlob.size, created_at: new Date().toISOString(),
            });
            setPreviewAssetId(assetId);
            refreshProjectFiles(project.id);
            setActiveAction(null);
            addConsoleEntry({ id: crypto.randomUUID(), level: 'log', message: `[Asset Studio] Animation complete → ${targetPath} (${animFrames} frames)`, timestamp: new Date().toISOString() });
        } catch (err) { setActionError(err instanceof Error ? err.message : 'Animation failed'); }
        finally { setActionBusy(false); setAssetGenerating(false); }
    };

    // ── Img2Img handler ──
    const handleImg2Img = async () => {
        if (!asset?.storage_key || !project?.id || !img2imgPrompt.trim()) return;
        setActionBusy(true);
        setActionError('');
        setAssetGenerating(true);

        const sourceUrl = `${window.location.origin}/api/assets/serve?key=${encodeURIComponent(asset.storage_key)}`;
        const baseName = img2imgPrompt.trim().replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
        const targetPath = `assets/${baseName}_v${Date.now() % 10000}.png`;

        addConsoleEntry({ id: crypto.randomUUID(), level: 'log', message: `[Asset Studio] Img2Img: "${img2imgPrompt}" (strength ${img2imgStrength})...`, timestamp: new Date().toISOString() });

        try {
            const res = await fetch('/api/assets/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project_id: project.id,
                    prompt: img2imgPrompt.trim(),
                    asset_type: 'sprite',
                    target_path: targetPath,
                    options: { source_image_url: sourceUrl, strength: img2imgStrength, width: asset.width || 512, height: asset.height || 512 },
                }),
            });
            const data = await res.json();
            if (res.ok && data.success) {
                const assetId = crypto.randomUUID();
                addAsset({
                    id: assetId, project_id: project.id,
                    name: img2imgPrompt.trim().slice(0, 40), asset_type: 'sprite',
                    storage_key: data.storage_key || targetPath, thumbnail_key: null, file_format: 'png',
                    width: asset.width, height: asset.height, metadata: { tags: ['img2img'] },
                    generation_prompt: img2imgPrompt.trim(), generation_model: null,
                    size_bytes: 0, created_at: new Date().toISOString(),
                });
                setPreviewAssetId(assetId);
                refreshProjectFiles(project.id);
                setActiveAction(null);
                addConsoleEntry({ id: crypto.randomUUID(), level: 'log', message: `[Asset Studio] Img2Img complete → ${targetPath}`, timestamp: new Date().toISOString() });
            } else {
                setActionError(data.error || 'Img2Img failed');
            }
        } catch { setActionError('Network error'); }
        finally { setActionBusy(false); setAssetGenerating(false); }
    };

    // If no asset selected, show empty state
    if (!asset) {
        return (
            <div className="relative w-full h-full bg-[#0a0a0f] flex flex-col items-center justify-center gap-3 text-zinc-600">
                <ImageIcon size={40} strokeWidth={1} />
                <p className="text-sm">No asset selected</p>
                <p className="text-xs text-zinc-700 text-center px-8">
                    Select an asset from the Gallery<br />to preview it here
                </p>
            </div>
        );
    }

    const isImage = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(asset.file_format);
    const isSpriteSheet = asset.asset_type === 'sprite_sheet';
    const canAnimate = isImage && !isSpriteSheet;
    const canImg2Img = isImage;

    return (
        <div className="relative w-full h-full bg-[#0a0a0f] flex flex-col overflow-hidden">
            {/* Top bar */}
            <div className="flex-shrink-0 flex items-center justify-between px-3 py-1.5 bg-black/40 border-b border-white/5 z-10">
                <div className="flex items-center gap-2 min-w-0">
                    <button onClick={goPrev} disabled={!hasPrev} className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 disabled:opacity-20 transition-colors">
                        <ChevronLeft size={14} />
                    </button>
                    <span className="text-xs text-zinc-300 truncate max-w-[200px]">{asset.name}</span>
                    <button onClick={goNext} disabled={!hasNext} className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 disabled:opacity-20 transition-colors">
                        <ChevronRight size={14} />
                    </button>
                </div>
                <div className="flex items-center gap-1.5">
                    {/* Action buttons */}
                    {canAnimate && (
                        <button
                            onClick={() => setActiveAction(activeAction === 'animate' ? null : 'animate')}
                            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors ${
                                activeAction === 'animate' ? 'bg-violet-500/20 text-violet-300' : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
                            }`}
                        >
                            <Film size={11} /> Animate
                        </button>
                    )}
                    {canImg2Img && (
                        <button
                            onClick={() => setActiveAction(activeAction === 'img2img' ? null : 'img2img')}
                            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors ${
                                activeAction === 'img2img' ? 'bg-fuchsia-500/20 text-fuchsia-300' : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
                            }`}
                        >
                            <Wand2 size={11} /> Img2Img
                        </button>
                    )}
                    <div className="w-px h-3 bg-white/10" />
                    <span className="text-[10px] text-zinc-600 font-mono">
                        {asset.file_format.toUpperCase()}
                        {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}
                    </span>
                    <button onClick={() => setPreviewAssetId(null)} className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors">
                        <X size={14} />
                    </button>
                </div>
            </div>

            {/* Action panel (slides down) */}
            {activeAction && (
                <ActionPanel
                    action={activeAction}
                    busy={actionBusy}
                    error={actionError}
                    asset={asset}
                    animPrompt={animPrompt} setAnimPrompt={setAnimPrompt}
                    animFrames={animFrames} setAnimFrames={setAnimFrames}
                    img2imgPrompt={img2imgPrompt} setImg2imgPrompt={setImg2imgPrompt}
                    img2imgStrength={img2imgStrength} setImg2imgStrength={setImg2imgStrength}
                    onAnimate={handleAnimate}
                    onImg2Img={handleImg2Img}
                    generating={assetGenerating}
                />
            )}

            {/* Main preview area */}
            {isImage ? (
                isSpriteSheet ? (
                    <SpriteSheetPreview asset={asset} />
                ) : (
                    <ImagePreviewCanvas asset={asset} />
                )
            ) : (
                <div className="flex-1 flex items-center justify-center text-zinc-600">
                    <div className="flex flex-col items-center gap-2">
                        <ImageIcon size={32} strokeWidth={1} />
                        <span className="text-xs">Preview not available for .{asset.file_format}</span>
                    </div>
                </div>
            )}

            {/* Asset info bar */}
            <div className="flex-shrink-0 px-3 py-1 bg-black/40 border-t border-white/5 flex items-center justify-between">
                <span className="text-[10px] text-zinc-600 font-mono">
                    {currentIdx + 1}/{assets.length}
                </span>
                <span className="text-[10px] text-zinc-600 font-mono">
                    {asset.size_bytes > 0 ? `${(asset.size_bytes / 1024).toFixed(1)}KB` : ''}
                    {asset.generation_model ? ` · ${asset.generation_model}` : ''}
                </span>
            </div>
        </div>
    );
}

// ── Action Panel ────────────────────────────────────────────────────────

function ActionPanel({ action, busy, error, asset, animPrompt, setAnimPrompt, animFrames, setAnimFrames, img2imgPrompt, setImg2imgPrompt, img2imgStrength, setImg2imgStrength, onAnimate, onImg2Img, generating }: {
    action: 'animate' | 'img2img';
    busy: boolean;
    error: string;
    asset: Asset;
    animPrompt: string; setAnimPrompt: (v: string) => void;
    animFrames: number; setAnimFrames: (v: number) => void;
    img2imgPrompt: string; setImg2imgPrompt: (v: string) => void;
    img2imgStrength: number; setImg2imgStrength: (v: number) => void;
    onAnimate: () => void;
    onImg2Img: () => void;
    generating: boolean;
}) {
    if (action === 'animate') {
        return (
            <div className="flex-shrink-0 bg-black/60 border-b border-white/5 px-3 py-2 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                    <Film size={12} className="text-violet-400 flex-shrink-0" />
                    <span className="text-[10px] uppercase tracking-wider text-zinc-400">Animate &quot;{asset.name.slice(0, 25)}&quot;</span>
                </div>
                {/* Animation prompt */}
                <textarea
                    value={animPrompt}
                    onChange={e => setAnimPrompt(e.target.value)}
                    placeholder="Describe the motion (e.g. 'walking forward', 'rocking on waves', 'spinning slowly'...)"
                    className="w-full bg-zinc-900 border border-white/10 rounded px-2 py-1.5 text-[11px] text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-violet-500/50 transition-colors"
                    rows={2}
                />
                {/* Frames */}
                <div className="flex items-center gap-2">
                    <label className="text-[10px] text-zinc-500 whitespace-nowrap">Frames</label>
                    <input type="range" min={2} max={12} value={animFrames} onChange={e => setAnimFrames(Number(e.target.value))} className="flex-1 accent-violet-500 h-1" />
                    <span className="text-[10px] text-zinc-400 w-4 text-center font-mono">{animFrames}</span>
                </div>
                {error && <p className="text-[10px] text-red-400">{error}</p>}
                <button onClick={onAnimate} disabled={busy || generating || !animPrompt.trim()}
                    className="w-full py-1.5 rounded bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white text-[11px] font-medium disabled:opacity-40 hover:brightness-110 transition-all flex items-center justify-center gap-1.5"
                >
                    {busy ? <><Loader2 size={11} className="animate-spin" />Generating {animFrames} frames...</> : <><Film size={11} />Generate Animation</>}
                </button>
            </div>
        );
    }

    return (
        <div className="flex-shrink-0 bg-black/60 border-b border-white/5 px-3 py-2 flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <Wand2 size={12} className="text-fuchsia-400 flex-shrink-0" />
                <span className="text-[10px] uppercase tracking-wider text-zinc-400">Img2Img variation</span>
            </div>
            {/* Prompt */}
            <textarea
                value={img2imgPrompt}
                onChange={e => setImg2imgPrompt(e.target.value)}
                placeholder="Describe the variation you want..."
                className="w-full bg-zinc-900 border border-white/10 rounded px-2 py-1.5 text-[11px] text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-fuchsia-500/50 transition-colors"
                rows={2}
            />
            {/* Strength */}
            <div className="flex items-center gap-2">
                <label className="text-[10px] text-zinc-500 whitespace-nowrap">Strength</label>
                <input type="range" min={0.1} max={0.95} step={0.05} value={img2imgStrength} onChange={e => setImg2imgStrength(Number(e.target.value))} className="flex-1 accent-fuchsia-500 h-1" />
                <span className="text-[10px] text-zinc-400 w-8 text-center font-mono">{img2imgStrength.toFixed(2)}</span>
            </div>
            <p className="text-[9px] text-zinc-600">Low = close to original · High = more creative freedom</p>
            {error && <p className="text-[10px] text-red-400">{error}</p>}
            <button onClick={onImg2Img} disabled={busy || generating || !img2imgPrompt.trim()}
                className="w-full py-1.5 rounded bg-gradient-to-r from-fuchsia-600 to-pink-600 text-white text-[11px] font-medium disabled:opacity-40 hover:brightness-110 transition-all flex items-center justify-center gap-1.5"
            >
                {busy ? <><Loader2 size={11} className="animate-spin" />Generating variation...</> : <><Wand2 size={11} />Generate Variation</>}
            </button>
        </div>
    );
}

// ── Image Preview with Zoom & Pan ────────────────────────────────────

interface PreviewProps {
    asset: { storage_key: string; name: string; width: number | null; height: number | null };
}

function ImagePreviewCanvas({ asset }: PreviewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [zoom, setZoom] = useState(1);
    const [zoomIdx, setZoomIdx] = useState(3); // index into ZOOM_LEVELS (1x)
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const [dragging, setDragging] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

    const imgSrc = `/api/assets/serve?key=${encodeURIComponent(asset.storage_key)}`;

    // Reset on asset change
    useEffect(() => {
        setZoom(1);
        setZoomIdx(3);
        setOffset({ x: 0, y: 0 });
        setLoaded(false);
    }, [asset.storage_key]);

    const changeZoom = (dir: 1 | -1) => {
        const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, zoomIdx + dir));
        setZoomIdx(next);
        setZoom(ZOOM_LEVELS[next]);
    };

    const fitToView = () => {
        setZoom(1);
        setZoomIdx(3);
        setOffset({ x: 0, y: 0 });
    };

    const handleWheel = useCallback((e: React.WheelEvent) => {
        e.preventDefault();
        changeZoom(e.deltaY < 0 ? 1 : -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [zoomIdx]);

    const handleMouseDown = (e: React.MouseEvent) => {
        if (e.button !== 0) return;
        setDragging(true);
        dragStart.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    };

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (!dragging) return;
        setOffset({
            x: dragStart.current.ox + (e.clientX - dragStart.current.x),
            y: dragStart.current.oy + (e.clientY - dragStart.current.y),
        });
    }, [dragging]);

    const handleMouseUp = () => setDragging(false);

    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            {/* Canvas */}
            <div
                ref={containerRef}
                className="flex-1 overflow-hidden relative cursor-grab active:cursor-grabbing"
                onWheel={handleWheel}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
            >
                {/* Checkerboard */}
                <div className="absolute inset-0 bg-[length:16px_16px] bg-[position:0_0,8px_8px] bg-[image:linear-gradient(45deg,#111118_25%,transparent_25%,transparent_75%,#111118_75%),linear-gradient(45deg,#111118_25%,transparent_25%,transparent_75%,#111118_75%)]" />

                <div
                    className="absolute inset-0 flex items-center justify-center"
                    style={{
                        transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
                        transition: dragging ? 'none' : 'transform 0.15s ease-out',
                        imageRendering: zoom >= 2 ? 'pixelated' : 'auto',
                    }}
                >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={imgSrc}
                        alt={asset.name}
                        onLoad={() => setLoaded(true)}
                        className={`max-w-full max-h-full object-contain transition-opacity ${loaded ? 'opacity-100' : 'opacity-0'}`}
                        draggable={false}
                    />
                </div>
            </div>

            {/* Zoom controls */}
            <div className="flex-shrink-0 flex items-center justify-center gap-1 py-1.5 bg-black/60 border-t border-white/5">
                <button onClick={() => changeZoom(-1)} className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors">
                    <ZoomOut size={13} />
                </button>
                <span className="text-[10px] text-zinc-400 font-mono w-12 text-center">
                    {Math.round(zoom * 100)}%
                </span>
                <button onClick={() => changeZoom(1)} className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors">
                    <ZoomIn size={13} />
                </button>
                <div className="w-px h-3 bg-white/10 mx-1" />
                <button onClick={fitToView} className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors" title="Fit to view">
                    <Maximize2 size={13} />
                </button>
            </div>
        </div>
    );
}

// ── Sprite Sheet Preview (frame rendering only — controls are in AnimationTimeline) ──

function SpriteSheetPreview({ asset }: PreviewProps) {
    const { animCurrentFrame } = useEditorStore();
    const imgRef = useRef<HTMLImageElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const frameCount = (asset as { metadata?: { frames?: unknown[] } }).metadata?.frames?.length || 4;
    const [loaded, setLoaded] = useState(false);
    const [imgSize, setImgSize] = useState({ w: 0, h: 0 });

    const imgSrc = `/api/assets/serve?key=${encodeURIComponent(asset.storage_key)}`;

    const frameW = imgSize.w > 0 ? Math.floor(imgSize.w / frameCount) : 0;
    const frameH = imgSize.h;

    // Draw current frame
    useEffect(() => {
        const canvas = canvasRef.current;
        const img = imgRef.current;
        if (!canvas || !img || !loaded || frameW === 0) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = frameW;
        canvas.height = frameH;
        ctx.clearRect(0, 0, frameW, frameH);
        const frame = animCurrentFrame % frameCount;
        ctx.drawImage(img, frame * frameW, 0, frameW, frameH, 0, 0, frameW, frameH);
    }, [animCurrentFrame, loaded, frameW, frameH, frameCount]);

    const handleImgLoad = () => {
        const img = imgRef.current;
        if (img) {
            setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
            setLoaded(true);
        }
    };

    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img ref={imgRef} src={imgSrc} alt="" onLoad={handleImgLoad} className="hidden" />

            <div className="flex-1 overflow-hidden relative flex items-center justify-center">
                <div className="absolute inset-0 bg-[length:16px_16px] bg-[position:0_0,8px_8px] bg-[image:linear-gradient(45deg,#111118_25%,transparent_25%,transparent_75%,#111118_75%),linear-gradient(45deg,#111118_25%,transparent_25%,transparent_75%,#111118_75%)]" />
                <canvas
                    ref={canvasRef}
                    className="relative z-10 max-w-full max-h-full object-contain"
                    style={{ imageRendering: 'pixelated' }}
                />
            </div>
        </div>
    );
}
