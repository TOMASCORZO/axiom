'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useEditorStore } from '@/lib/store';
import {
    Image as ImageIcon,
    ZoomIn,
    ZoomOut,
    Maximize2,
    X,
    ChevronLeft,
    ChevronRight,
} from 'lucide-react';

const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

export default function AssetPreview() {
    const { assets, previewAssetId, setPreviewAssetId } = useEditorStore();
    const asset = assets.find((a) => a.id === previewAssetId) ?? null;

    // Navigation between assets
    const currentIdx = asset ? assets.indexOf(asset) : -1;
    const hasPrev = currentIdx > 0;
    const hasNext = currentIdx >= 0 && currentIdx < assets.length - 1;

    const goPrev = () => { if (hasPrev) setPreviewAssetId(assets[currentIdx - 1].id); };
    const goNext = () => { if (hasNext) setPreviewAssetId(assets[currentIdx + 1].id); };

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

    return (
        <div className="relative w-full h-full bg-[#0a0a0f] flex flex-col overflow-hidden">
            {/* Top bar */}
            <div className="flex-shrink-0 flex items-center justify-between px-3 py-1.5 bg-black/40 border-b border-white/5 z-10">
                <div className="flex items-center gap-2 min-w-0">
                    <button
                        onClick={goPrev}
                        disabled={!hasPrev}
                        className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 disabled:opacity-20 transition-colors"
                    >
                        <ChevronLeft size={14} />
                    </button>
                    <span className="text-xs text-zinc-300 truncate max-w-[200px]">{asset.name}</span>
                    <button
                        onClick={goNext}
                        disabled={!hasNext}
                        className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 disabled:opacity-20 transition-colors"
                    >
                        <ChevronRight size={14} />
                    </button>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-[10px] text-zinc-600 font-mono">
                        {asset.file_format.toUpperCase()}
                        {asset.width && asset.height ? ` \u00b7 ${asset.width}\u00d7${asset.height}` : ''}
                    </span>
                    <button
                        onClick={() => setPreviewAssetId(null)}
                        className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                    >
                        <X size={14} />
                    </button>
                </div>
            </div>

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
                    {asset.generation_model ? ` \u00b7 ${asset.generation_model}` : ''}
                </span>
            </div>
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
