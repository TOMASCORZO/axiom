'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useEditorStore } from '@/lib/store';
import { useMapEditorStore } from '@/lib/map-store';
import { Map as MapIcon, Save, Undo2, Redo2, Loader2 } from 'lucide-react';
import type { MapMetadataShape } from '@/types/asset';

// ── Image cache ──
// Loads images for the current tile + object libraries. Keyed by storage_key
// so the cache survives re-renders and remains stable across edits.
function useImageCache(storageKeys: string[]): Map<string, HTMLImageElement> {
    const [cache, setCache] = useState<Map<string, HTMLImageElement>>(() => new Map());

    useEffect(() => {
        let cancelled = false;
        const missing = storageKeys.filter(k => !cache.has(k));
        if (missing.length === 0) return;
        for (const key of missing) {
            const img = new Image();
            img.onload = () => {
                if (cancelled) return;
                setCache(prev => {
                    if (prev.has(key)) return prev;
                    const next = new Map(prev);
                    next.set(key, img);
                    return next;
                });
            };
            img.src = `/api/assets/serve?key=${encodeURIComponent(key)}`;
        }
        return () => { cancelled = true; };
        // cache is intentionally omitted: we only want to re-run when storageKeys changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storageKeys]);

    return cache;
}

function placementLookup(meta: MapMetadataShape) {
    const lib = new Map(meta.objects_library.map(o => [o.id, o]));
    return lib;
}

export default function MapCanvas() {
    const {
        metadata, tool, selectedTileId, selectedObjectId,
        paintCell, eraseCell, placeObject, removePlacement,
        undo, redoAction, dirty, saving, saveError,
        assetId, history, redo,
    } = useMapEditorStore();
    const { project, addConsoleEntry } = useEditorStore();

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const dragRef = useRef<{ active: boolean; startX: number; startY: number; ox: number; oy: number; panning: boolean } | null>(null);
    const painting = useRef(false);

    const storageKeys = useMemo(() => {
        if (!metadata) return [] as string[];
        const tileKeys = metadata.tiles.map(t => t.storage_key);
        const objectKeys = metadata.objects_library.map(o => o.storage_key);
        return [...tileKeys, ...objectKeys];
    }, [metadata]);

    const imageCache = useImageCache(storageKeys);

    const tileSize = metadata?.tile_size ?? 32;
    const gridW = metadata?.grid_w ?? 0;
    const gridH = metadata?.grid_h ?? 0;

    // ── Draw ──
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !metadata) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const pxW = gridW * tileSize;
        const pxH = gridH * tileSize;
        canvas.width = pxW;
        canvas.height = pxH;
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, pxW, pxH);

        // Tiles
        const tileById = new Map(metadata.tiles.map(t => [t.id, t]));
        for (let y = 0; y < gridH; y++) {
            for (let x = 0; x < gridW; x++) {
                const id = metadata.grid[y]?.[x];
                if (!id) continue;
                const t = tileById.get(id);
                if (!t) continue;
                const img = imageCache.get(t.storage_key);
                if (img) {
                    ctx.drawImage(img, x * tileSize, y * tileSize, tileSize, tileSize);
                } else {
                    // placeholder while loading
                    ctx.fillStyle = '#1e1e2a';
                    ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
                }
            }
        }

        // Placements
        const objLib = placementLookup(metadata);
        for (const p of metadata.placements) {
            const obj = objLib.get(p.object_id);
            if (!obj) continue;
            const img = imageCache.get(obj.storage_key);
            if (img) {
                ctx.drawImage(img, p.grid_x * tileSize, p.grid_y * tileSize, obj.width, obj.height);
            }
        }

        // Grid overlay
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        for (let x = 0; x <= gridW; x++) {
            ctx.beginPath();
            ctx.moveTo(x * tileSize + 0.5, 0);
            ctx.lineTo(x * tileSize + 0.5, pxH);
            ctx.stroke();
        }
        for (let y = 0; y <= gridH; y++) {
            ctx.beginPath();
            ctx.moveTo(0, y * tileSize + 0.5);
            ctx.lineTo(pxW, y * tileSize + 0.5);
            ctx.stroke();
        }

        // Looping badge overlay
        if (metadata.mode === 'looping') {
            ctx.strokeStyle = 'rgba(236,72,153,0.6)';
            ctx.setLineDash([6, 6]);
            ctx.lineWidth = 2;
            ctx.strokeRect(1, 1, pxW - 2, pxH - 2);
            ctx.setLineDash([]);
        }
    }, [metadata, imageCache, gridW, gridH, tileSize]);

    // Fit-to-view when asset changes
    useEffect(() => {
        const c = containerRef.current;
        if (!c || !metadata) return;
        const cw = c.clientWidth;
        const ch = c.clientHeight;
        const pxW = gridW * tileSize;
        const pxH = gridH * tileSize;
        if (pxW === 0 || pxH === 0) return;
        const fit = Math.min(cw / pxW, ch / pxH) * 0.9;
        setZoom(fit);
        setPan({ x: (cw - pxW * fit) / 2, y: (ch - pxH * fit) / 2 });
    }, [assetId, gridW, gridH, tileSize, metadata]);

    // ── Input ──
    const canvasCoordsFromEvent = useCallback((e: React.MouseEvent): { x: number; y: number } | null => {
        const c = canvasRef.current;
        const container = containerRef.current;
        if (!c || !container) return null;
        const rect = container.getBoundingClientRect();
        const relX = e.clientX - rect.left - pan.x;
        const relY = e.clientY - rect.top - pan.y;
        const x = Math.floor(relX / (tileSize * zoom));
        const y = Math.floor(relY / (tileSize * zoom));
        if (x < 0 || y < 0 || x >= gridW || y >= gridH) return null;
        return { x, y };
    }, [pan.x, pan.y, zoom, tileSize, gridW, gridH]);

    const applyTool = useCallback((cellX: number, cellY: number) => {
        if (tool === 'paint' && selectedTileId) {
            paintCell(cellX, cellY, selectedTileId);
        } else if (tool === 'erase') {
            eraseCell(cellX, cellY);
        } else if (tool === 'place_object' && selectedObjectId) {
            placeObject(cellX, cellY, selectedObjectId);
        }
    }, [tool, selectedTileId, selectedObjectId, paintCell, eraseCell, placeObject]);

    const handleMouseDown = (e: React.MouseEvent) => {
        if (e.button === 1 || (e.button === 0 && (e.metaKey || e.ctrlKey || tool === 'pan'))) {
            dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, ox: pan.x, oy: pan.y, panning: true };
            return;
        }
        if (e.button === 0) {
            const cell = canvasCoordsFromEvent(e);
            if (cell) {
                painting.current = true;
                applyTool(cell.x, cell.y);
            }
        }
        if (e.button === 2) {
            // right click: remove placement under cursor
            const cell = canvasCoordsFromEvent(e);
            if (!cell || !metadata) return;
            const hit = metadata.placements.find(p => {
                const obj = metadata.objects_library.find(o => o.id === p.object_id);
                if (!obj) return false;
                const wCells = Math.ceil(obj.width / tileSize);
                const hCells = Math.ceil(obj.height / tileSize);
                return cell.x >= p.grid_x && cell.x < p.grid_x + wCells &&
                    cell.y >= p.grid_y && cell.y < p.grid_y + hCells;
            });
            if (hit) removePlacement(hit.id);
        }
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (dragRef.current?.active && dragRef.current.panning) {
            setPan({
                x: dragRef.current.ox + (e.clientX - dragRef.current.startX),
                y: dragRef.current.oy + (e.clientY - dragRef.current.startY),
            });
            return;
        }
        if (painting.current) {
            const cell = canvasCoordsFromEvent(e);
            if (cell) applyTool(cell.x, cell.y);
        }
    };

    const endDrag = () => {
        painting.current = false;
        if (dragRef.current) dragRef.current.active = false;
    };

    const handleWheel = (e: React.WheelEvent) => {
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1.1 : 0.9;
        const next = Math.max(0.1, Math.min(zoom * dir, 8));
        setZoom(next);
    };

    // Keyboard shortcuts
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); undo(); }
            else if ((e.metaKey || e.ctrlKey) && (e.shiftKey && e.key === 'z' || e.key === 'y')) { e.preventDefault(); redoAction(); }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [undo, redoAction]);

    // Save (recompose) handler
    const handleSave = async () => {
        if (!metadata || !assetId || !project?.id) return;
        useMapEditorStore.getState().setSaving(true);
        useMapEditorStore.getState().setSaveError(null);
        try {
            const targetPath = `assets/maps/${assetId}.png`;
            const res = await fetch('/api/assets/map-action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'recompose',
                    project_id: project.id,
                    asset_id: assetId,
                    target_path: targetPath,
                    metadata,
                }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                useMapEditorStore.getState().setSaveError(data.error || `HTTP ${res.status}`);
                return;
            }
            useMapEditorStore.getState().markSaved();
            // Update the asset in the editor store so gallery reflects new snapshot
            const editor = useEditorStore.getState();
            const updated = editor.assets.map(a =>
                a.id === assetId
                    ? { ...a, storage_key: data.storage_key, width: data.width, height: data.height, metadata: { ...a.metadata, map: metadata } }
                    : a,
            );
            editor.setAssets(updated);
            addConsoleEntry({
                id: crypto.randomUUID(),
                level: 'log',
                message: `[Map Studio] Saved map → ${targetPath}`,
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            useMapEditorStore.getState().setSaveError(err instanceof Error ? err.message : 'Save failed');
        } finally {
            useMapEditorStore.getState().setSaving(false);
        }
    };

    if (!metadata) {
        return (
            <div className="w-full h-full bg-[#0a0a0f] flex flex-col items-center justify-center text-zinc-600 gap-3">
                <MapIcon size={40} strokeWidth={1} />
                <p className="text-sm">No map selected</p>
                <p className="text-xs text-zinc-700 text-center px-8">Generate a map or select one from the gallery to start editing.</p>
            </div>
        );
    }

    return (
        <div className="relative w-full h-full bg-[#0a0a0f] flex flex-col overflow-hidden">
            {/* Top toolbar */}
            <div className="flex-shrink-0 flex items-center justify-between px-3 py-1.5 bg-black/40 border-b border-white/5 z-10">
                <div className="flex items-center gap-1.5">
                    <button
                        onClick={undo}
                        disabled={history.length === 0}
                        className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-white/5 disabled:opacity-30 transition-colors"
                        title="Undo (Cmd/Ctrl+Z)"
                    >
                        <Undo2 size={13} />
                    </button>
                    <button
                        onClick={redoAction}
                        disabled={redo.length === 0}
                        className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-white/5 disabled:opacity-30 transition-colors"
                        title="Redo (Cmd/Ctrl+Shift+Z)"
                    >
                        <Redo2 size={13} />
                    </button>
                    <div className="w-px h-3 bg-white/10 mx-1" />
                    <span className="text-[10px] text-zinc-500 font-mono">
                        {gridW}×{gridH} · {tileSize}px · {metadata.mode}
                    </span>
                </div>
                <div className="flex items-center gap-1.5">
                    {dirty && <span className="text-[10px] text-amber-400">● unsaved</span>}
                    {saveError && <span className="text-[10px] text-red-400 max-w-[240px] truncate">{saveError}</span>}
                    <button
                        onClick={handleSave}
                        disabled={!dirty || saving}
                        className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 disabled:opacity-30 transition-colors"
                    >
                        {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>

            {/* Canvas viewport */}
            <div
                ref={containerRef}
                className="flex-1 overflow-hidden relative select-none"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={endDrag}
                onMouseLeave={endDrag}
                onWheel={handleWheel}
                onContextMenu={(e) => e.preventDefault()}
                style={{ cursor: tool === 'pan' ? 'grab' : 'crosshair' }}
            >
                <div className="absolute inset-0 bg-[length:16px_16px] bg-[position:0_0,8px_8px] bg-[image:linear-gradient(45deg,#111118_25%,transparent_25%,transparent_75%,#111118_75%),linear-gradient(45deg,#111118_25%,transparent_25%,transparent_75%,#111118_75%)]" />
                <canvas
                    ref={canvasRef}
                    className="absolute origin-top-left"
                    style={{
                        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                        imageRendering: 'pixelated',
                    }}
                />
            </div>

            {/* Status bar */}
            <div className="flex-shrink-0 px-3 py-1 bg-black/40 border-t border-white/5 flex items-center justify-between">
                <span className="text-[10px] text-zinc-600 font-mono">
                    {metadata.tiles.length} tiles · {metadata.objects_library.length} objects · {metadata.placements.length} placed
                </span>
                <span className="text-[10px] text-zinc-600 font-mono">{Math.round(zoom * 100)}%</span>
            </div>
        </div>
    );
}
