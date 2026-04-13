'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useEditorStore } from '@/lib/store';
import { useMapEditorStore, STACK_STEP_RATIO } from '@/lib/map-store';
import { Map as MapIcon, Save, Undo2, Redo2, Loader2 } from 'lucide-react';
import type { MapWangTile, TerrainCorner } from '@/types/asset';

/** MIME type identifying an asset drag from the Gallery. Data is the asset id. */
export const MAP_ASSET_DRAG_MIME = 'application/x-axiom-asset';

// ── Image cache ─────────────────────────────────────────────────────
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

// ── Wang tile picker (client-side preview; server is authoritative on save) ──
function pickWangTile(
    cellCorners: { NW: TerrainCorner; NE: TerrainCorner; SW: TerrainCorner; SE: TerrainCorner },
    tiles: MapWangTile[],
): MapWangTile | null {
    if (tiles.length === 0) return null;
    const exact = tiles.find(t =>
        t.corners.NW === cellCorners.NW &&
        t.corners.NE === cellCorners.NE &&
        t.corners.SW === cellCorners.SW &&
        t.corners.SE === cellCorners.SE,
    );
    if (exact) return exact;
    // Majority-corner fallback: find a solid tile for the dominant terrain.
    const counts: Record<string, number> = {};
    counts[cellCorners.NW] = (counts[cellCorners.NW] ?? 0) + 1;
    counts[cellCorners.NE] = (counts[cellCorners.NE] ?? 0) + 1;
    counts[cellCorners.SW] = (counts[cellCorners.SW] ?? 0) + 1;
    counts[cellCorners.SE] = (counts[cellCorners.SE] ?? 0) + 1;
    const majority = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] as TerrainCorner;
    const solid = tiles.find(t =>
        t.corners.NW === majority &&
        t.corners.NE === majority &&
        t.corners.SW === majority &&
        t.corners.SE === majority,
    );
    return solid ?? tiles[0];
}

// Flat colour for corner preview when no Wang tile matches / is loaded.
const TERRAIN_FALLBACK: Record<TerrainCorner, string> = {
    lower: '#3b7a3e',
    upper: '#7a7066',
    transition: '#a37538',
};

// ── Main ────────────────────────────────────────────────────────────

export default function MapCanvas() {
    const {
        metadata, tool,
        selectedTerrain, selectedIsoTileId, selectedObjectId,
        paintAt, eraseAt, placeObject, placeAsset, removePlacement,
        stackAdd, stackPop,
        undo, redoAction, dirty, saving, saveError,
        assetId, history, redo,
    } = useMapEditorStore();
    const { project, addConsoleEntry, assets } = useEditorStore();

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const dragRef = useRef<{ active: boolean; startX: number; startY: number; ox: number; oy: number; panning: boolean } | null>(null);
    const painting = useRef(false);

    // Asset-id → asset lookup for placements that came from Gallery drags.
    const assetById = useMemo(() => new Map(assets.map(a => [a.id, a])), [assets]);

    const storageKeys = useMemo(() => {
        if (!metadata) return [] as string[];
        const tileKeys =
            metadata.projection === 'isometric'
                ? (metadata.iso_tiles ?? []).map(t => t.storage_key)
                : (metadata.wang_tiles ?? []).map(t => t.storage_key);
        const objectKeys = metadata.objects_library.map(o => o.storage_key);
        // Project assets referenced by placements (drag-dropped sprites / animations).
        const assetKeys = metadata.placements
            .map(p => p.asset_id ? assetById.get(p.asset_id)?.storage_key : null)
            .filter((k): k is string => !!k);
        return [...tileKeys, ...objectKeys, ...assetKeys];
    }, [metadata, assetById]);

    const imageCache = useImageCache(storageKeys);

    const tileSize = metadata?.tile_size ?? 32;
    const gridW = metadata?.grid_w ?? 0;
    const gridH = metadata?.grid_h ?? 0;
    const isIso = metadata?.projection === 'isometric';

    // Iso render metrics — derived from first iso tile if available.
    const isoTileRenderW = isIso ? (metadata?.iso_tiles?.[0]?.width ?? tileSize * 2) : 0;
    const isoTileRenderH = isIso ? (metadata?.iso_tiles?.[0]?.height ?? tileSize * 2) : 0;
    const halfW = tileSize / 2;
    const halfH = tileSize / 4;
    const stackStep = tileSize * STACK_STEP_RATIO;

    // Deepest stack anywhere on the grid — drives vertical headroom.
    const maxStackDepth = useMemo(() => {
        if (!isIso || !metadata?.iso_stack) return 0;
        let max = 0;
        for (const row of metadata.iso_stack) for (const cell of row) if (cell.length > max) max = cell.length;
        return max;
    }, [isIso, metadata?.iso_stack]);
    const stackHeadroom = isIso ? Math.max(0, maxStackDepth - 1) * stackStep : 0;

    // Shift so the leftmost diamond starts at x = 0.
    const isoOffsetX = isIso ? gridH * halfW : 0;
    const isoOffsetY = stackHeadroom; // leave room above for stacked levels.

    const pxW = isIso
        ? Math.ceil((gridW + gridH) * halfW + isoTileRenderW)
        : gridW * tileSize;
    const pxH = isIso
        ? Math.ceil((gridW + gridH) * halfH + isoTileRenderH + stackHeadroom)
        : gridH * tileSize;

    // ── Draw ──
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !metadata) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = pxW;
        canvas.height = pxH;
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, pxW, pxH);

        if (isIso) {
            // ── Isometric (stacked) ──
            const tiles = metadata.iso_tiles ?? [];
            const tileById = new Map(tiles.map(t => [t.id, t]));
            const stack = metadata.iso_stack
                ?? (metadata.iso_grid ?? []).map(row => row.map(id => (id ? [id] : [])));

            // Back-to-front: iterate by diagonals so farther tiles render first.
            // Within a cell, paint bottom (level 0) up so higher tiles occlude.
            for (let y = 0; y < gridH; y++) {
                for (let x = 0; x < gridW; x++) {
                    const cellStack = stack[y]?.[x] ?? [];
                    const anchorX = (x - y) * halfW + isoOffsetX;
                    const anchorY = (x + y) * halfH + isoOffsetY;
                    if (cellStack.length === 0) {
                        // Placeholder diamond at ground level.
                        ctx.fillStyle = '#141420';
                        ctx.beginPath();
                        ctx.moveTo(anchorX, anchorY);
                        ctx.lineTo(anchorX + halfW, anchorY + halfH);
                        ctx.lineTo(anchorX, anchorY + 2 * halfH);
                        ctx.lineTo(anchorX - halfW, anchorY + halfH);
                        ctx.closePath();
                        ctx.fill();
                        continue;
                    }
                    for (let level = 0; level < cellStack.length; level++) {
                        const t = tileById.get(cellStack[level]);
                        if (!t) continue;
                        const img = imageCache.get(t.storage_key);
                        const drawX = anchorX - t.width / 2;
                        const drawY = anchorY - (t.height - tileSize / 2) - level * stackStep;
                        if (img) {
                            ctx.drawImage(img, drawX, drawY, t.width, t.height);
                        } else {
                            ctx.fillStyle = '#1e1e2a';
                            ctx.fillRect(drawX, drawY, t.width, t.height);
                        }
                    }
                }
            }

            // Placements in iso: support both object_id (library) and asset_id (Gallery drag).
            const objLib = new Map(metadata.objects_library.map(o => [o.id, o]));
            // Back-to-front placement order matches cell order.
            const sortedPlacements = [...metadata.placements].sort((a, b) => {
                const da = a.grid_x + a.grid_y;
                const db = b.grid_x + b.grid_y;
                if (da !== db) return da - db;
                return (a.z_level ?? 0) - (b.z_level ?? 0);
            });
            for (const p of sortedPlacements) {
                let storageKey: string | null = null;
                let w = tileSize;
                let h = tileSize;
                if (p.asset_id) {
                    const a = assetById.get(p.asset_id);
                    if (!a) continue;
                    storageKey = a.storage_key;
                    w = a.width ?? tileSize;
                    h = a.height ?? tileSize;
                } else if (p.object_id) {
                    const obj = objLib.get(p.object_id);
                    if (!obj) continue;
                    storageKey = obj.storage_key;
                    w = obj.width;
                    h = obj.height;
                }
                if (!storageKey) continue;
                const anchorX = (p.grid_x - p.grid_y) * halfW + isoOffsetX;
                const anchorY = (p.grid_x + p.grid_y) * halfH + isoOffsetY - (p.z_level ?? 0) * stackStep;
                const img = imageCache.get(storageKey);
                if (img) {
                    ctx.drawImage(img, anchorX - w / 2, anchorY - (h - tileSize / 2), w, h);
                }
            }

            // Cell-edge overlay — faint diamond outlines at ground level.
            ctx.strokeStyle = 'rgba(255,255,255,0.05)';
            ctx.lineWidth = 1;
            for (let y = 0; y < gridH; y++) {
                for (let x = 0; x < gridW; x++) {
                    const ax = (x - y) * halfW + isoOffsetX;
                    const ay = (x + y) * halfH + isoOffsetY;
                    ctx.beginPath();
                    ctx.moveTo(ax, ay);
                    ctx.lineTo(ax + halfW, ay + halfH);
                    ctx.lineTo(ax, ay + 2 * halfH);
                    ctx.lineTo(ax - halfW, ay + halfH);
                    ctx.closePath();
                    ctx.stroke();
                }
            }
        } else {
            // ── Orthogonal (Wang) ──
            const wangTiles = metadata.wang_tiles ?? [];
            const corners = metadata.corners ?? [];

            for (let y = 0; y < gridH; y++) {
                for (let x = 0; x < gridW; x++) {
                    const NW = corners[y]?.[x] ?? 'lower';
                    const NE = corners[y]?.[x + 1] ?? 'lower';
                    const SW = corners[y + 1]?.[x] ?? 'lower';
                    const SE = corners[y + 1]?.[x + 1] ?? 'lower';
                    const tile = pickWangTile({ NW, NE, SW, SE }, wangTiles);
                    if (tile) {
                        const img = imageCache.get(tile.storage_key);
                        if (img) {
                            ctx.drawImage(img, x * tileSize, y * tileSize, tileSize, tileSize);
                        } else {
                            ctx.fillStyle = TERRAIN_FALLBACK[NW];
                            ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
                        }
                    } else {
                        // No wang tiles at all — use per-corner fallback quads.
                        ctx.fillStyle = TERRAIN_FALLBACK[NW];
                        ctx.fillRect(x * tileSize, y * tileSize, tileSize / 2, tileSize / 2);
                        ctx.fillStyle = TERRAIN_FALLBACK[NE];
                        ctx.fillRect(x * tileSize + tileSize / 2, y * tileSize, tileSize / 2, tileSize / 2);
                        ctx.fillStyle = TERRAIN_FALLBACK[SW];
                        ctx.fillRect(x * tileSize, y * tileSize + tileSize / 2, tileSize / 2, tileSize / 2);
                        ctx.fillStyle = TERRAIN_FALLBACK[SE];
                        ctx.fillRect(x * tileSize + tileSize / 2, y * tileSize + tileSize / 2, tileSize / 2, tileSize / 2);
                    }
                }
            }

            // Placements — support both object_id (library) and asset_id (Gallery drag).
            const objLib = new Map(metadata.objects_library.map(o => [o.id, o]));
            for (const p of metadata.placements) {
                let storageKey: string | null = null;
                let w = tileSize;
                let h = tileSize;
                if (p.asset_id) {
                    const a = assetById.get(p.asset_id);
                    if (!a) continue;
                    storageKey = a.storage_key;
                    w = a.width ?? tileSize;
                    h = a.height ?? tileSize;
                } else if (p.object_id) {
                    const obj = objLib.get(p.object_id);
                    if (!obj) continue;
                    storageKey = obj.storage_key;
                    w = obj.width;
                    h = obj.height;
                }
                if (!storageKey) continue;
                const img = imageCache.get(storageKey);
                if (img) {
                    ctx.drawImage(img, p.grid_x * tileSize, p.grid_y * tileSize, w, h);
                }
            }

            // Cell grid overlay
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

            // Corner markers — small dots on each corner intersection to remind
            // the user that "paint" targets corners, not cells.
            ctx.fillStyle = 'rgba(167,139,250,0.4)';
            for (let y = 0; y <= gridH; y++) {
                for (let x = 0; x <= gridW; x++) {
                    const label = corners[y]?.[x] ?? 'lower';
                    if (label !== 'lower') {
                        ctx.fillStyle = label === 'upper' ? 'rgba(250,250,250,0.5)' : 'rgba(250,200,100,0.5)';
                        ctx.fillRect(x * tileSize - 1, y * tileSize - 1, 3, 3);
                    }
                }
            }
        }

        // Looping badge overlay
        if (metadata.mode === 'looping') {
            ctx.strokeStyle = 'rgba(236,72,153,0.6)';
            ctx.setLineDash([6, 6]);
            ctx.lineWidth = 2;
            ctx.strokeRect(1, 1, pxW - 2, pxH - 2);
            ctx.setLineDash([]);
        }
    }, [metadata, imageCache, gridW, gridH, tileSize, isIso, pxW, pxH, halfW, halfH, isoOffsetX, isoOffsetY, stackStep, assetById]);

    // Fit-to-view when asset changes
    useEffect(() => {
        const c = containerRef.current;
        if (!c || !metadata) return;
        const cw = c.clientWidth;
        const ch = c.clientHeight;
        if (pxW === 0 || pxH === 0) return;
        const fit = Math.min(cw / pxW, ch / pxH) * 0.9;
        setZoom(fit);
        setPan({ x: (cw - pxW * fit) / 2, y: (ch - pxH * fit) / 2 });
    }, [assetId, gridW, gridH, tileSize, isIso, metadata, pxW, pxH]);

    // ── Input ──
    // Returns a coordinate in the projection-appropriate space:
    //   - Ortho paint/erase: corner coords (0..gridW, 0..gridH inclusive)
    //   - Ortho place_object / Iso all: cell coords (0..gridW-1, 0..gridH-1)
    const coordsFromEvent = useCallback((
        e: React.MouseEvent,
        kind: 'corner' | 'cell',
    ): { x: number; y: number } | null => {
        const container = containerRef.current;
        if (!container) return null;
        const rect = container.getBoundingClientRect();
        const relX = (e.clientX - rect.left - pan.x) / zoom;
        const relY = (e.clientY - rect.top - pan.y) / zoom;

        if (isIso) {
            // Inverse iso projection: anchor at top of diamond (ground level).
            const lx = relX - isoOffsetX;
            const ly = relY - isoOffsetY;
            const u = lx / halfW;    // x - y
            const v = ly / halfH;    // x + y
            const x = Math.floor((u + v) / 2);
            const y = Math.floor((v - u) / 2);
            if (x < 0 || y < 0 || x >= gridW || y >= gridH) return null;
            return { x, y };
        }
        if (kind === 'corner') {
            const x = Math.round(relX / tileSize);
            const y = Math.round(relY / tileSize);
            if (x < 0 || y < 0 || x > gridW || y > gridH) return null;
            return { x, y };
        }
        const x = Math.floor(relX / tileSize);
        const y = Math.floor(relY / tileSize);
        if (x < 0 || y < 0 || x >= gridW || y >= gridH) return null;
        return { x, y };
    }, [pan.x, pan.y, zoom, tileSize, gridW, gridH, isIso, halfW, halfH, isoOffsetX, isoOffsetY]);

    const applyTool = useCallback((e: React.MouseEvent) => {
        if (tool === 'paint') {
            if (isIso) {
                if (!selectedIsoTileId) return;
                const c = coordsFromEvent(e, 'cell');
                if (c) paintAt(c.x, c.y);
            } else {
                // Paint a corner.
                const c = coordsFromEvent(e, 'corner');
                if (c) paintAt(c.x, c.y);
            }
        } else if (tool === 'erase') {
            if (isIso) {
                const c = coordsFromEvent(e, 'cell');
                if (c) eraseAt(c.x, c.y);
            } else {
                const c = coordsFromEvent(e, 'corner');
                if (c) eraseAt(c.x, c.y);
            }
        } else if (tool === 'place_object' && selectedObjectId) {
            const c = coordsFromEvent(e, 'cell');
            if (c) placeObject(c.x, c.y, selectedObjectId);
        } else if (tool === 'stack_add') {
            const c = coordsFromEvent(e, 'cell');
            if (c) stackAdd(c.x, c.y);
        } else if (tool === 'stack_pop') {
            const c = coordsFromEvent(e, 'cell');
            if (c) stackPop(c.x, c.y);
        }
    }, [tool, selectedIsoTileId, selectedObjectId, coordsFromEvent, paintAt, eraseAt, placeObject, stackAdd, stackPop, isIso]);

    const handleMouseDown = (e: React.MouseEvent) => {
        if (e.button === 1 || (e.button === 0 && (e.metaKey || e.ctrlKey || tool === 'pan'))) {
            dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, ox: pan.x, oy: pan.y, panning: true };
            return;
        }
        if (e.button === 0) {
            painting.current = true;
            applyTool(e);
        }
        if (e.button === 2) {
            // right click: remove topmost placement under cursor.
            const cell = coordsFromEvent(e, 'cell');
            if (!cell || !metadata) return;
            // Iterate in reverse (and highest z first) so we hit the visually topmost placement.
            const candidates = [...metadata.placements]
                .map((p, i) => ({ p, i }))
                .sort((a, b) => ((b.p.z_level ?? 0) - (a.p.z_level ?? 0)) || (b.i - a.i));
            const hit = candidates.find(({ p }) => {
                let w = tileSize, h = tileSize;
                if (p.asset_id) {
                    const a = assetById.get(p.asset_id);
                    if (!a) return false;
                    w = a.width ?? tileSize;
                    h = a.height ?? tileSize;
                } else if (p.object_id) {
                    const obj = metadata.objects_library.find(o => o.id === p.object_id);
                    if (!obj) return false;
                    w = obj.width;
                    h = obj.height;
                } else {
                    return false;
                }
                const wCells = Math.max(1, Math.ceil(w / tileSize));
                const hCells = Math.max(1, Math.ceil(h / tileSize));
                return cell.x >= p.grid_x && cell.x < p.grid_x + wCells &&
                    cell.y >= p.grid_y && cell.y < p.grid_y + hCells;
            });
            if (hit) removePlacement(hit.p.id);
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
            applyTool(e);
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

    const handleDragOver = (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes(MAP_ASSET_DRAG_MIME)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        }
    };

    const handleDrop = (e: React.DragEvent) => {
        const assetDragId = e.dataTransfer.getData(MAP_ASSET_DRAG_MIME);
        if (!assetDragId) return;
        e.preventDefault();
        // Synthesize a minimal MouseEvent-like shape for coordsFromEvent.
        const c = coordsFromEvent(
            { clientX: e.clientX, clientY: e.clientY } as React.MouseEvent,
            'cell',
        );
        if (!c) return;
        placeAsset(c.x, c.y, assetDragId);
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

    const tileCount = isIso ? (metadata.iso_tiles?.length ?? 0) : (metadata.wang_tiles?.length ?? 0);
    const tileLabel = isIso ? 'iso tiles' : 'wang tiles';

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
                        {metadata.projection} · {gridW}×{gridH} · {tileSize}px · {metadata.mode}
                        {!isIso && tool === 'paint' && (
                            <> · brush: <span className="text-violet-400">{selectedTerrain}</span></>
                        )}
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
                onDragOver={handleDragOver}
                onDrop={handleDrop}
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
                    {tileCount} {tileLabel} · {metadata.objects_library.length} objects · {metadata.placements.length} placed
                </span>
                <span className="text-[10px] text-zinc-600 font-mono">{Math.round(zoom * 100)}%</span>
            </div>
        </div>
    );
}
