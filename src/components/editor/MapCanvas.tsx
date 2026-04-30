'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useEditorStore } from '@/lib/store';
import { useMapEditorStore, computeStackStep } from '@/lib/map-store';
import { toast } from '@/lib/toast';
import { Map as MapIcon, Save, Undo2, Redo2, Loader2, Wand2, X } from 'lucide-react';
import type { MapWangTile, TerrainCorner } from '@/types/asset';

/** MIME type identifying an asset drag from the Gallery. Data is the asset id. */
export const MAP_ASSET_DRAG_MIME = 'application/x-axiom-asset';

// ── Image cache ─────────────────────────────────────────────────────
// Loads images for the current tile + object libraries. Keyed by storage_key
// so the cache survives re-renders and remains stable across edits.
//
// Concurrency cap: the previous implementation kicked off ALL image fetches
// in parallel — for a 16-tile Wang map + 50-object library the browser would
// open 60+ simultaneous connections, saturate the network, and starve other
// /api requests in the editor. We now run a small worker pool (MAX_CONCURRENT
// = 6) so loads come in waves. Errors don't block the queue — a single bad
// storage_key just leaves a hole in the canvas (renders as the placeholder).
const MAX_CONCURRENT_IMAGE_LOADS = 6;

function useImageCache(storageKeys: string[]): Map<string, HTMLImageElement> {
    const [cache, setCache] = useState<Map<string, HTMLImageElement>>(() => new Map());

    useEffect(() => {
        let cancelled = false;
        const missing = storageKeys.filter(k => !cache.has(k));
        if (missing.length === 0) return;

        const queue = [...missing];
        let inFlight = 0;

        const pump = () => {
            while (!cancelled && inFlight < MAX_CONCURRENT_IMAGE_LOADS && queue.length > 0) {
                const key = queue.shift();
                if (!key) break;
                inFlight++;
                const img = new Image();
                const finish = () => {
                    inFlight--;
                    pump();
                };
                img.onload = () => {
                    if (!cancelled) {
                        setCache(prev => {
                            if (prev.has(key)) return prev;
                            const next = new Map(prev);
                            next.set(key, img);
                            return next;
                        });
                    }
                    finish();
                };
                img.onerror = () => {
                    // Don't block the queue on a single bad key. The canvas
                    // already falls back to placeholder when imageCache.get()
                    // returns undefined.
                    finish();
                };
                img.src = `/api/assets/serve?key=${encodeURIComponent(key)}`;
            }
        };

        pump();
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
        addObjectToLibrary,
    } = useMapEditorStore();
    const { project, addConsoleEntry, assets } = useEditorStore();

    // Inpaint rectangle (orthogonal only). Cell coords on the map grid.
    type InpaintRect = { startCell: { x: number; y: number }; endCell: { x: number; y: number }; frozen: boolean };
    const [inpaintRect, setInpaintRect] = useState<InpaintRect | null>(null);
    const [inpaintPrompt, setInpaintPrompt] = useState('');
    const [inpaintBusy, setInpaintBusy] = useState(false);
    const [inpaintError, setInpaintError] = useState<string | null>(null);

    // Reset inpaint state on tool change so a stale rect from a previous tool
    // session doesn't bleed into the next one. Also reset when the active map
    // changes — a frozen rect from another map is meaningless here.
    useEffect(() => {
        if (tool !== 'inpaint') {
            setInpaintRect(null);
            setInpaintPrompt('');
            setInpaintError(null);
        }
    }, [tool, assetId]);

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

    // Iso render metrics — prefer the tallest tile so top-row blocks never
    // clip regardless of which variant landed there. Width is informational
    // only (horizontal centering happens per-tile on draw).
    const isoTileRenderW = isIso ? (metadata?.iso_tiles?.[0]?.width ?? tileSize * 2) : 0;
    const isoTileRenderH = isIso
        ? ((metadata?.iso_tiles ?? []).reduce((m, t) => Math.max(m, t.height), 0) || tileSize * 2)
        : 0;
    const halfW = tileSize / 2;
    const halfH = tileSize / 4;
    const stackStep = computeStackStep(tileSize, isoTileRenderH || tileSize);

    // Deepest stack anywhere on the grid — drives vertical headroom.
    const maxStackDepth = useMemo(() => {
        if (!isIso || !metadata?.iso_stack) return 0;
        let max = 0;
        for (const row of metadata.iso_stack) for (const cell of row) if (cell.length > max) max = cell.length;
        return max;
    }, [isIso, metadata?.iso_stack]);
    const stackHeadroom = isIso ? Math.max(0, maxStackDepth - 1) * stackStep : 0;
    // Extra room above the (0,0) diamond for tall blocks — a tile image is
    // `isoTileRenderH` tall but the diamond footprint only occupies the
    // bottom `tileSize/2`. Without this the top row of cubes clips off.
    const isoTopOverhang = isIso ? Math.max(0, isoTileRenderH - tileSize / 2) : 0;

    // Shift so the leftmost diamond starts at x = 0.
    const isoOffsetX = isIso ? gridH * halfW : 0;
    const isoOffsetY = isoTopOverhang + stackHeadroom;

    const pxW = isIso
        ? Math.ceil((gridW + gridH) * halfW + isoTileRenderW)
        : gridW * tileSize;
    const pxH = isIso
        ? Math.ceil((gridW + gridH) * halfH + tileSize / 2 + isoTopOverhang + stackHeadroom)
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

            // Placements in iso, grouped by layer so opacity + visibility are
            // honoured. Within each layer we keep the back-to-front cell order
            // so stacked sprites still occlude correctly.
            const objLib = new Map(metadata.objects_library.map(o => [o.id, o]));
            const layers = metadata.layers ?? [];
            const sortedLayers = [...layers].sort((a, b) => a.z_order - b.z_order)
                .filter(l => l.visible && l.kind !== 'collision');
            for (const layer of sortedLayers) {
                const layerPlacements = metadata.placements
                    .filter(p => (p.layer_id ?? layer.id) === layer.id
                        || (layer.kind === 'terrain' && !p.layer_id))
                    .sort((a, b) => {
                        const da = a.grid_x + a.grid_y;
                        const db = b.grid_x + b.grid_y;
                        if (da !== db) return da - db;
                        return (a.z_level ?? 0) - (b.z_level ?? 0);
                    });
                if (layerPlacements.length === 0) continue;
                const prevAlpha = ctx.globalAlpha;
                ctx.globalAlpha = prevAlpha * layer.opacity;
                for (const p of layerPlacements) {
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
                ctx.globalAlpha = prevAlpha;
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

            // Placements, layer-grouped. Same filter + opacity rules as iso.
            const objLib = new Map(metadata.objects_library.map(o => [o.id, o]));
            const layers = metadata.layers ?? [];
            const sortedLayers = [...layers].sort((a, b) => a.z_order - b.z_order)
                .filter(l => l.visible && l.kind !== 'collision');
            for (const layer of sortedLayers) {
                const layerPlacements = metadata.placements.filter(p =>
                    (p.layer_id ?? layer.id) === layer.id
                    || (layer.kind === 'terrain' && !p.layer_id),
                );
                if (layerPlacements.length === 0) continue;
                const prevAlpha = ctx.globalAlpha;
                ctx.globalAlpha = prevAlpha * layer.opacity;
                for (const p of layerPlacements) {
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
                ctx.globalAlpha = prevAlpha;
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
    }, [metadata, imageCache, gridW, gridH, tileSize, isIso, pxW, pxH, halfW, halfH, isoOffsetX, isoOffsetY, stackStep, assetById, isoTopOverhang]);

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
        // Inpaint: drag a cell-aligned rectangle. Ortho only — iso projection
        // doesn't have a 1:1 cell→pixel mapping that PixelLab's inpainting can
        // consume directly.
        if (e.button === 0 && tool === 'inpaint' && !isIso) {
            const cell = coordsFromEvent(e, 'cell');
            if (cell) {
                setInpaintRect({ startCell: cell, endCell: cell, frozen: false });
                setInpaintError(null);
            }
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
            const lockedLayerIds = new Set(
                (metadata.layers ?? []).filter(l => l.locked || !l.visible).map(l => l.id),
            );
            // Iterate in reverse (and highest z first) so we hit the visually topmost placement.
            // Skip placements on hidden/locked layers — they aren't visible,
            // so right-clicking through them would be surprising.
            const candidates = [...metadata.placements]
                .map((p, i) => ({ p, i }))
                .filter(({ p }) => !(p.layer_id && lockedLayerIds.has(p.layer_id)))
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
        if (inpaintRect && !inpaintRect.frozen) {
            const cell = coordsFromEvent(e, 'cell');
            if (cell) setInpaintRect(r => r ? { ...r, endCell: cell } : r);
            return;
        }
        if (painting.current) {
            applyTool(e);
        }
    };

    const endDrag = () => {
        painting.current = false;
        if (dragRef.current) dragRef.current.active = false;
        // Freeze the inpaint rect on mouseup. Discard if collapsed (zero area).
        if (inpaintRect && !inpaintRect.frozen) {
            const w = Math.abs(inpaintRect.endCell.x - inpaintRect.startCell.x) + 1;
            const h = Math.abs(inpaintRect.endCell.y - inpaintRect.startCell.y) + 1;
            if (w < 1 || h < 1) {
                setInpaintRect(null);
            } else {
                setInpaintRect(r => r ? { ...r, frozen: true } : r);
            }
        }
    };

    const handleWheel = (e: React.WheelEvent) => {
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1.1 : 0.9;
        const next = Math.max(0.1, Math.min(zoom * dir, 8));
        setZoom(next);
    };

    // Normalized rect in cell coords (top-left + size) — used for both render
    // and submission so they stay in sync.
    const inpaintCellRect = inpaintRect ? (() => {
        const x0 = Math.min(inpaintRect.startCell.x, inpaintRect.endCell.x);
        const y0 = Math.min(inpaintRect.startCell.y, inpaintRect.endCell.y);
        const w = Math.abs(inpaintRect.endCell.x - inpaintRect.startCell.x) + 1;
        const h = Math.abs(inpaintRect.endCell.y - inpaintRect.startCell.y) + 1;
        return { x: x0, y: y0, w, h };
    })() : null;

    const cancelInpaint = () => {
        setInpaintRect(null);
        setInpaintPrompt('');
        setInpaintError(null);
    };

    const runInpaint = async () => {
        if (!inpaintCellRect || !inpaintPrompt.trim() || !project?.id || !metadata || !assetId) return;
        const currentAsset = assets.find(a => a.id === assetId);
        if (!currentAsset?.storage_key) {
            setInpaintError('Map has no storage key — save the map first.');
            return;
        }
        setInpaintBusy(true);
        setInpaintError(null);
        try {
            // Convert cell coords → pixel coords on the composed map PNG.
            const pxX = inpaintCellRect.x * tileSize;
            const pxY = inpaintCellRect.y * tileSize;
            const pxW = inpaintCellRect.w * tileSize;
            const pxH = inpaintCellRect.h * tileSize;
            const slug = inpaintPrompt.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20) || 'inpaint';
            const target = `assets/maps/objects/${slug}_${Date.now() % 100000}.png`;

            const res = await fetch('/api/assets/map-action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'generate_object',
                    project_id: project.id,
                    prompt: inpaintPrompt.trim(),
                    tile_size: tileSize,
                    width_tiles: inpaintCellRect.w,
                    height_tiles: inpaintCellRect.h,
                    view: 'high top-down',
                    target_path: target,
                    background_storage_key: currentAsset.storage_key,
                    inpaint_region: { shape: 'rectangle', x: pxX, y: pxY, width: pxW, height: pxH },
                }),
            });
            const data = await res.json();
            if (res.status === 429) {
                const reason = typeof data.error === 'string' ? data.error : 'Rate limit reached';
                setInpaintError(reason);
                toast.warn('Rate limit reached', { detail: reason });
                return;
            }
            if (!res.ok || !data.success) {
                const msg = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
                setInpaintError(msg);
                toast.error('Inpaint failed', { detail: msg });
                return;
            }
            // Stash the generated object in the library and place it at the
            // top-left cell of the inpaint rect. The user can move/delete it
            // afterwards like any other placement.
            addObjectToLibrary(data.object);
            placeObject(inpaintCellRect.x, inpaintCellRect.y, data.object.id);
            toast.success('Region inpainted', { detail: `${inpaintCellRect.w}×${inpaintCellRect.h} cells` });
            addConsoleEntry({
                id: crypto.randomUUID(), level: 'log',
                message: `[Map Studio] Inpaint → "${inpaintPrompt.trim()}" at (${inpaintCellRect.x},${inpaintCellRect.y}) ${inpaintCellRect.w}×${inpaintCellRect.h} cells`,
                timestamp: new Date().toISOString(),
            });
            cancelInpaint();
        } catch (err) {
            setInpaintError(err instanceof Error ? err.message : 'Network error');
        } finally {
            setInpaintBusy(false);
        }
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
        // Hard guard against double-submit. Without this, a user can spam-click
        // Save during a slow recompose (Wang composes 16 tiles + N placements
        // can take 20s+) and orphan storage uploads.
        if (useMapEditorStore.getState().saving) return;
        useMapEditorStore.getState().setSaving(true);
        useMapEditorStore.getState().setSaveError(null);
        try {
            const targetPath = `assets/maps/${assetId}.png`;
            // Include the version we loaded so the server can CAS. If the DB
            // has advanced past this (concurrent save elsewhere) we get 409.
            const expectedVersion = metadata.version ?? 0;
            const res = await fetch('/api/assets/map-action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'recompose',
                    project_id: project.id,
                    asset_id: assetId,
                    target_path: targetPath,
                    metadata,
                    expected_version: expectedVersion,
                }),
            });
            const data = await res.json();
            if (res.status === 409 || data?.conflict) {
                const conflictMsg = typeof data.error === 'string' ? data.error : 'Map was modified elsewhere — reload to continue';
                useMapEditorStore.getState().setSaveError(conflictMsg);
                toast.error('Save conflict', { detail: conflictMsg });
                return;
            }
            if (!res.ok || !data.success) {
                const errMsg = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
                useMapEditorStore.getState().setSaveError(errMsg);
                toast.error('Save failed', { detail: errMsg });
                return;
            }
            // Adopt the new version the server assigned, so subsequent saves
            // pass the correct expected_version.
            const newVersion = typeof data.version === 'number' ? data.version : expectedVersion + 1;
            const newMetadata = { ...metadata, version: newVersion };
            useMapEditorStore.setState({ metadata: newMetadata });
            useMapEditorStore.getState().markSaved();
            // Update the asset in the editor store so gallery reflects new snapshot
            const editor = useEditorStore.getState();
            const updated = editor.assets.map(a =>
                a.id === assetId
                    ? { ...a, storage_key: data.storage_key, width: data.width, height: data.height, metadata: { ...a.metadata, map: newMetadata } }
                    : a,
            );
            editor.setAssets(updated);
            addConsoleEntry({
                id: crypto.randomUUID(),
                level: 'log',
                message: `[Map Studio] Saved map → ${targetPath}`,
                timestamp: new Date().toISOString(),
            });
            toast.success('Map saved');
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : 'Save failed';
            useMapEditorStore.getState().setSaveError(errMsg);
            toast.error('Save failed', { detail: errMsg });
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
                style={{ cursor: tool === 'pan' ? 'grab' : tool === 'inpaint' ? 'crosshair' : 'crosshair' }}
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

                {/* Inpaint selection rectangle (ortho only). Positioned in the
                    same transformed space as the canvas so it tracks pan/zoom. */}
                {inpaintCellRect && !isIso && (
                    <div
                        className="absolute origin-top-left pointer-events-none"
                        style={{
                            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                        }}
                    >
                        <div
                            className={`absolute border-2 ${inpaintRect?.frozen ? 'border-violet-400 bg-violet-400/10' : 'border-violet-300 border-dashed bg-violet-300/5'}`}
                            style={{
                                left: inpaintCellRect.x * tileSize,
                                top: inpaintCellRect.y * tileSize,
                                width: inpaintCellRect.w * tileSize,
                                height: inpaintCellRect.h * tileSize,
                            }}
                        />
                    </div>
                )}

                {/* Recompose lock — covers the canvas during save so the user
                    can't paint into stale state (their edits would be lost
                    when the new metadata version comes back from the server). */}
                {saving && (
                    <div className="absolute inset-0 z-30 bg-zinc-950/40 backdrop-blur-[1px] flex items-center justify-center pointer-events-auto">
                        <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-900/95 border border-violet-500/30 shadow-xl shadow-black/40">
                            <Loader2 size={14} className="animate-spin text-violet-400" />
                            <span className="text-xs text-zinc-200">Recomposing map…</span>
                        </div>
                    </div>
                )}

                {/* Inpaint popover form — appears once the rect is frozen. */}
                {inpaintRect?.frozen && inpaintCellRect && !isIso && (
                    <div
                        className="absolute z-20 w-[260px] bg-zinc-900/95 backdrop-blur border border-violet-500/40 rounded-lg shadow-xl shadow-black/40 p-3 flex flex-col gap-2"
                        style={{
                            // Position the popover at the rect's bottom-right in screen coords.
                            left: pan.x + (inpaintCellRect.x + inpaintCellRect.w) * tileSize * zoom + 8,
                            top: pan.y + inpaintCellRect.y * tileSize * zoom,
                        }}
                    >
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5 text-[11px] text-violet-300 font-medium">
                                <Wand2 size={11} /> Inpaint region
                            </div>
                            <button onClick={cancelInpaint} className="text-zinc-500 hover:text-zinc-200" title="Cancel (Esc)">
                                <X size={12} />
                            </button>
                        </div>
                        <div className="text-[10px] text-zinc-500 font-mono">
                            ({inpaintCellRect.x},{inpaintCellRect.y}) · {inpaintCellRect.w}×{inpaintCellRect.h} cells · {inpaintCellRect.w * tileSize}×{inpaintCellRect.h * tileSize} px
                        </div>
                        <textarea
                            value={inpaintPrompt}
                            onChange={e => setInpaintPrompt(e.target.value)}
                            rows={3}
                            autoFocus
                            placeholder='What goes here? e.g. "small village with stone houses"'
                            className="w-full bg-zinc-950 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-violet-500/50"
                            onKeyDown={(e) => {
                                if (e.key === 'Escape') cancelInpaint();
                                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runInpaint();
                            }}
                        />
                        {inpaintError && <div className="text-[10px] text-red-400">{inpaintError}</div>}
                        <div className="flex gap-1.5">
                            <button
                                onClick={cancelInpaint}
                                className="flex-1 py-1.5 text-[11px] rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={runInpaint}
                                disabled={!inpaintPrompt.trim() || inpaintBusy}
                                className="flex-1 py-1.5 text-[11px] rounded bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white font-medium disabled:opacity-40 flex items-center justify-center gap-1"
                            >
                                {inpaintBusy ? <><Loader2 size={11} className="animate-spin" /> Generating…</> : <><Wand2 size={11} /> Inpaint</>}
                            </button>
                        </div>
                    </div>
                )}
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
