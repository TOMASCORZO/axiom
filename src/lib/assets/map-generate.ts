/**
 * Map Studio backend — tile/object generation + projection-aware compositor.
 *
 * Two projections are supported:
 *   - ORTHOGONAL: Wang tileset from PixelLab /create-tileset. Each cell has
 *                 four corner terrain labels; the compositor picks the
 *                 matching Wang tile so edges blend correctly.
 *   - ISOMETRIC:  A set of diamond tile variants from /create-tiles-pro with
 *                 tile_type:'isometric', rendered back-to-front in diamond
 *                 projection. Thin edge strokes are ignored in the compositor
 *                 (tiles paint into slightly overlapping bounds).
 *
 * Objects (trees/rocks/characters) are painted on top in both modes via
 * /map-objects (optionally with background_image + inpainting for style lock).
 */

import {
    createTileset,
    createTilesPro,
    createIsometricTile,
    createMapObject,
    extractTilesProBuffers,
    extractTilesProUrls,
    extractIsoTileBuffer,
    extractMapObjectBuffer,
    decodeB64,
    type CreateTilesetResp,
    type WangTileResp,
} from './pixellab-maps';
import type { TerrainCorner } from '@/types/asset';

// ── Wang tileset generation ──────────────────────────────────────────

export interface GenerateWangTilesetOptions {
    lower: string;          // lower terrain description (e.g. "grass")
    upper: string;          // upper terrain (e.g. "stone path")
    transition?: string;    // optional blend band
    tileSize?: 16 | 32;
    view?: 'low top-down' | 'high top-down';
    seed?: number;
}

export interface GeneratedWangTile {
    pixellabId: string;
    buffer: Buffer;
    corners: { NW: TerrainCorner; NE: TerrainCorner; SW: TerrainCorner; SE: TerrainCorner };
    name: string;
}

export interface GenerateWangTilesetResult {
    success: boolean;
    tiles: GeneratedWangTile[];
    tileSize: number;
    error?: string;
    cost: number;
}

function normalizeCorners(c: WangTileResp['corners']): GeneratedWangTile['corners'] {
    // Guard against missing/partial corner data — default missing to 'lower'.
    return {
        NW: (c?.NW ?? 'lower') as TerrainCorner,
        NE: (c?.NE ?? 'lower') as TerrainCorner,
        SW: (c?.SW ?? 'lower') as TerrainCorner,
        SE: (c?.SE ?? 'lower') as TerrainCorner,
    };
}

export async function generateWangTileset(opts: GenerateWangTilesetOptions): Promise<GenerateWangTilesetResult> {
    try {
        const resp: CreateTilesetResp = await createTileset({
            lowerDescription: opts.lower,
            upperDescription: opts.upper,
            transitionDescription: opts.transition,
            tileSize: opts.tileSize ?? 32,
            view: opts.view ?? 'high top-down',
            transitionSize: opts.transition ? 0.5 : 0,
            seed: opts.seed,
        });

        const tsTiles = resp.tileset?.tiles ?? [];
        if (tsTiles.length === 0) {
            return { success: false, tiles: [], tileSize: opts.tileSize ?? 32, cost: 0, error: 'Tileset response contained no tiles' };
        }

        const out: GeneratedWangTile[] = [];
        for (const t of tsTiles) {
            const buf = decodeB64(t.image?.base64);
            if (!buf) continue;
            out.push({
                pixellabId: t.id,
                buffer: buf,
                corners: normalizeCorners(t.corners),
                name: t.name ?? t.description ?? '',
            });
        }
        if (out.length === 0) {
            return { success: false, tiles: [], tileSize: opts.tileSize ?? 32, cost: 0, error: 'No decodable tiles in tileset response' };
        }

        return {
            success: true,
            tiles: out,
            tileSize: resp.tileset?.tile_size?.width ?? opts.tileSize ?? 32,
            cost: resp.usage?.usd ?? 0,
        };
    } catch (err) {
        return { success: false, tiles: [], tileSize: opts.tileSize ?? 32, cost: 0, error: err instanceof Error ? err.message : 'Wang tileset generation failed' };
    }
}

// ── Isometric tile generation ────────────────────────────────────────

export type IsoView = 'top-down' | 'high top-down' | 'low top-down' | 'side';

export interface GenerateIsoTilesOptions {
    /** Numbered prompts carry the tile count — e.g. "1). grass 2). dirt 3). stone". */
    description: string;
    tileSize?: number;      // 16-256, default 32 (footprint width)
    /** Explicit tile pixel height. Makes iso tiles render as taller blocks.
     *  When omitted, PixelLab computes from tileView + tile_type geometry. */
    tileHeight?: number;
    /** View preset — controls implicit depth. */
    tileView?: IsoView;
    /** 0.0 flat → 1.0 tall block. Overrides tileView's implicit depth. */
    tileDepthRatio?: number;
    seed?: number;
}

export interface GeneratedIsoTile {
    buffer: Buffer;
    width: number;
    height: number;
}

export interface GenerateIsoTilesResult {
    success: boolean;
    tiles: GeneratedIsoTile[];
    error?: string;
    cost: number;
}

export async function generateIsoTiles(opts: GenerateIsoTilesOptions): Promise<GenerateIsoTilesResult> {
    try {
        const resp = await createTilesPro({
            description: opts.description,
            tileType: 'isometric',
            tileSize: opts.tileSize ?? 32,
            tileHeight: opts.tileHeight,
            tileView: opts.tileView,
            tileDepthRatio: opts.tileDepthRatio,
            seed: opts.seed,
        });

        // Try base64 path first; fall back to storage URLs when the endpoint
        // returned remote URLs instead of inline base64.
        const ts = opts.tileSize ?? 32;
        // When caller passed an explicit height we trust it; otherwise we'll
        // measure the actual PNG dimensions after fetch.
        const fallbackH = opts.tileHeight ?? ts;
        const tiles: GeneratedIsoTile[] = [];
        const sharp = (await import('sharp')).default;

        const measure = async (buf: Buffer): Promise<{ w: number; h: number }> => {
            try {
                const meta = await sharp(buf).metadata();
                return { w: meta.width ?? ts, h: meta.height ?? fallbackH };
            } catch {
                return { w: ts, h: fallbackH };
            }
        };

        const b64Bufs = extractTilesProBuffers(resp);
        if (b64Bufs.length > 0) {
            for (const b of b64Bufs) {
                const { w, h } = await measure(b);
                tiles.push({ buffer: b, width: w, height: h });
            }
        } else {
            const urls = extractTilesProUrls(resp);
            for (const url of urls) {
                try {
                    const fetched = await fetch(url, { signal: AbortSignal.timeout(30_000) });
                    if (!fetched.ok) continue;
                    const ab = await fetched.arrayBuffer();
                    const buf = Buffer.from(ab);
                    const { w, h } = await measure(buf);
                    tiles.push({ buffer: buf, width: w, height: h });
                } catch (err) {
                    console.warn(`[map-generate] iso tile URL fetch failed: ${url}`, err);
                }
            }
        }

        if (tiles.length === 0) {
            // Log the actual response so we can diagnose schema drift. Strip
            // heavy base64 payloads before logging to keep the output readable.
            const redacted = JSON.parse(JSON.stringify(resp), (_k, v) =>
                typeof v === 'string' && v.length > 200 ? `<str:${v.length} chars>` : v,
            );
            console.error('[map-generate] tiles-pro response (redacted):', JSON.stringify(redacted).slice(0, 1500));
            return { success: false, tiles: [], cost: 0, error: 'No decodable iso tiles in tiles-pro response' };
        }

        return { success: true, tiles, cost: resp.usage?.usd ?? 0 };
    } catch (err) {
        return { success: false, tiles: [], cost: 0, error: err instanceof Error ? err.message : 'Iso tiles generation failed' };
    }
}

// Single iso tile — convenience used by the single-tile generator in MapStudio.
export interface GenerateSingleIsoTileOptions {
    prompt: string;
    tileSize?: 16 | 32;
    shape?: 'thin tile' | 'thick tile' | 'block';
    seed?: number;
}

export async function generateSingleIsoTile(opts: GenerateSingleIsoTileOptions): Promise<{ success: boolean; buffer?: Buffer; width: number; height: number; cost: number; error?: string }> {
    try {
        const ts = opts.tileSize ?? 32;
        const resp = await createIsometricTile({
            description: opts.prompt,
            width: ts * 2,       // give the model canvas room for the diamond + height
            height: ts * 2,
            isoShape: opts.shape ?? 'block',
            isoTileSize: ts,
            seed: opts.seed,
        });
        const buf = extractIsoTileBuffer(resp);
        if (!buf) return { success: false, width: 0, height: 0, cost: 0, error: 'No image in iso tile response' };
        return { success: true, buffer: buf, width: ts * 2, height: ts * 2, cost: resp.usage?.usd ?? 0 };
    } catch (err) {
        return { success: false, width: 0, height: 0, cost: 0, error: err instanceof Error ? err.message : 'Iso tile generation failed' };
    }
}

// ── Map object generation ────────────────────────────────────────────

export interface GenerateMapObjectOptions {
    prompt: string;
    tileSize: number;
    widthTiles?: number;
    heightTiles?: number;
    view?: 'low top-down' | 'high top-down' | 'side';
    /** Optional composed map PNG for style-match via inpainting. */
    backgroundImageBase64?: string;
    seed?: number;
}

export interface GenerateMapObjectResult {
    success: boolean;
    buffer?: Buffer;
    width: number;
    height: number;
    cost: number;
    error?: string;
}

export async function generateMapObjectV2(opts: GenerateMapObjectOptions): Promise<GenerateMapObjectResult> {
    try {
        const wTiles = Math.max(1, Math.min(opts.widthTiles ?? 1, 4));
        const hTiles = Math.max(1, Math.min(opts.heightTiles ?? 1, 4));
        // With inpainting, max area is 192×192; without, 400×400. Stay well under both.
        const maxDim = opts.backgroundImageBase64 ? 192 : 256;
        let width = Math.min(opts.tileSize * wTiles * 2, maxDim); // 2× upscale for detail
        let height = Math.min(opts.tileSize * hTiles * 2, maxDim);
        // Width/height must be at least 32 per API spec.
        width = Math.max(32, width);
        height = Math.max(32, height);

        const resp = await createMapObject({
            description: opts.prompt,
            width,
            height,
            view: opts.view ?? 'high top-down',
            backgroundImageBase64: opts.backgroundImageBase64,
            seed: opts.seed,
        });
        const buf = extractMapObjectBuffer(resp);
        if (!buf) {
            return { success: false, width: 0, height: 0, cost: 0, error: 'No image in map-object response' };
        }
        return { success: true, buffer: buf, width, height, cost: resp.usage?.usd ?? 0 };
    } catch (err) {
        return { success: false, width: 0, height: 0, cost: 0, error: err instanceof Error ? err.message : 'Map object generation failed' };
    }
}

// ── Wang tile lookup ─────────────────────────────────────────────────

export interface WangTileLookup {
    id: string;
    buffer: Buffer;
    corners: { NW: TerrainCorner; NE: TerrainCorner; SW: TerrainCorner; SE: TerrainCorner };
}

/**
 * Given the current corner labels of a cell, pick the Wang tile whose
 * corners match. Exact match preferred; if none, fall back to the tile
 * whose dominant corner matches the majority terrain of the cell.
 */
export function pickWangTile(
    cellCorners: { NW: TerrainCorner; NE: TerrainCorner; SW: TerrainCorner; SE: TerrainCorner },
    tiles: WangTileLookup[],
): WangTileLookup | null {
    if (tiles.length === 0) return null;
    for (const t of tiles) {
        if (
            t.corners.NW === cellCorners.NW &&
            t.corners.NE === cellCorners.NE &&
            t.corners.SW === cellCorners.SW &&
            t.corners.SE === cellCorners.SE
        ) return t;
    }
    // Fallback: majority-corner match
    const counts: Record<string, number> = {};
    (Object.values(cellCorners) as string[]).forEach(v => { counts[v] = (counts[v] ?? 0) + 1; });
    const majority = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!majority) return tiles[0];
    const majorityTile = tiles.find(t => Object.values(t.corners).every(c => c === majority));
    return majorityTile ?? tiles[0];
}

// ── Orthogonal (Wang) compositor ─────────────────────────────────────

export interface ComposeWangArgs {
    tileSize: number;
    gridW: number;              // cell columns
    gridH: number;              // cell rows
    corners: TerrainCorner[][]; // (gridH+1) × (gridW+1)
    wangTiles: WangTileLookup[];
    /** Object placements in cell coordinates. Rendered on top. */
    placements?: Array<{ buffer: Buffer; gridX: number; gridY: number; width: number; height: number }>;
}

export async function composeWangMap(args: ComposeWangArgs): Promise<Buffer> {
    const sharp = (await import('sharp')).default;
    const { tileSize, gridW, gridH, corners, wangTiles } = args;
    const canvasW = tileSize * gridW;
    const canvasH = tileSize * gridH;

    // Normalize all wang tiles to tileSize × tileSize up front.
    const normalized = new Map<string, Buffer>();
    for (const t of wangTiles) {
        normalized.set(t.id, await sharp(t.buffer).resize(tileSize, tileSize, { fit: 'fill' }).png().toBuffer());
    }

    const composites: Array<{ input: Buffer; left: number; top: number }> = [];
    for (let y = 0; y < gridH; y++) {
        for (let x = 0; x < gridW; x++) {
            const cellCorners = {
                NW: corners[y]?.[x] ?? 'lower',
                NE: corners[y]?.[x + 1] ?? 'lower',
                SW: corners[y + 1]?.[x] ?? 'lower',
                SE: corners[y + 1]?.[x + 1] ?? 'lower',
            } as const;
            const picked = pickWangTile(cellCorners, wangTiles);
            if (!picked) continue;
            const buf = normalized.get(picked.id);
            if (!buf) continue;
            composites.push({ input: buf, left: x * tileSize, top: y * tileSize });
        }
    }

    for (const p of args.placements ?? []) {
        const buf = await sharp(p.buffer).resize(p.width, p.height, { fit: 'fill' }).png().toBuffer();
        composites.push({ input: buf, left: p.gridX * tileSize, top: p.gridY * tileSize });
    }

    const base = sharp({
        create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    });
    return composites.length > 0 ? base.composite(composites).png().toBuffer() : base.png().toBuffer();
}

// ── Isometric compositor ─────────────────────────────────────────────
//
// Diamond projection:
//   screen_x = (x - y) * (tileSize / 2) + offset_x
//   screen_y = (x + y) * (tileSize / 4) + offset_y
//
// Each iso tile's natural canvas is 2× tileSize square (width = 2·tileSize,
// height ~= 2·tileSize), but the diamond footprint on the map is tileSize
// wide × tileSize/2 tall. Tiles are drawn back-to-front: iterate y ascending,
// x ascending per row, and within each cell bottom-of-stack → top-of-stack
// with a vertical offset per level (STACK_STEP_RATIO × tile_size).

/** Fraction of tile_size that each stack level rises on screen. Keep in sync
 *  with the client-side constant in map-store.ts. */
export const STACK_STEP_RATIO = 0.5;

export interface ComposeIsoArgs {
    tileSize: number;           // footprint width = tileSize; height = tileSize/2
    gridW: number;
    gridH: number;
    /** grid[y][x] = array of tile buffers bottom → top. Each cell may stack
     *  multiple tiles; empty array = empty cell. */
    tileStack: (Buffer | null)[][][];
    /** Natural render size of each tile. Should be consistent (e.g. 2×tileSize). */
    tileRenderWidth: number;
    tileRenderHeight: number;
    placements?: Array<{
        buffer: Buffer;
        gridX: number;
        gridY: number;
        width: number;
        height: number;
        /** Stack level the placement sits on top of (default 0 = ground). */
        zLevel?: number;
    }>;
}

export async function composeIsoMap(args: ComposeIsoArgs): Promise<Buffer> {
    const sharp = (await import('sharp')).default;
    const { tileSize, gridW, gridH, tileStack, tileRenderWidth, tileRenderHeight } = args;

    // Max stack depth across all cells — we grow the canvas upward to fit.
    let maxStack = 0;
    for (let y = 0; y < gridH; y++) {
        for (let x = 0; x < gridW; x++) {
            const depth = tileStack[y]?.[x]?.length ?? 0;
            if (depth > maxStack) maxStack = depth;
        }
    }
    const stackStep = tileSize * STACK_STEP_RATIO;
    const stackHeadroom = Math.max(0, maxStack - 1) * stackStep;

    // Canvas size: the diamond's extents plus headroom for stack levels.
    const diamondW = (gridW + gridH) * (tileSize / 2);
    const diamondH = (gridW + gridH) * (tileSize / 4);
    const canvasW = Math.ceil(diamondW + tileRenderWidth);
    const canvasH = Math.ceil(diamondH + tileRenderHeight + stackHeadroom);

    // Origin: (0,0) cell's top-left on screen so nothing clips.
    const offsetX = gridH * (tileSize / 2);
    const offsetY = stackHeadroom; // shift down so stacked cells don't clip off the top.

    const composites: Array<{ input: Buffer; left: number; top: number }> = [];

    const normalized = new Map<Buffer, Buffer>();
    const getNorm = async (b: Buffer): Promise<Buffer> => {
        const hit = normalized.get(b);
        if (hit) return hit;
        const n = await sharp(b).resize(tileRenderWidth, tileRenderHeight, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
        normalized.set(b, n);
        return n;
    };

    // Paint back-to-front by cell, then bottom-to-top within each cell's stack.
    for (let y = 0; y < gridH; y++) {
        for (let x = 0; x < gridW; x++) {
            const stack = tileStack[y]?.[x] ?? [];
            for (let level = 0; level < stack.length; level++) {
                const buf = stack[level];
                if (!buf) continue;
                const worldX = (x - y) * (tileSize / 2);
                const worldY = (x + y) * (tileSize / 4);
                const screenX = worldX + offsetX - (tileRenderWidth - tileSize) / 2;
                const screenY = worldY + offsetY - (tileRenderHeight - tileSize / 2) - level * stackStep;
                const norm = await getNorm(buf);
                composites.push({ input: norm, left: Math.round(screenX), top: Math.round(screenY) });
            }
        }
    }

    // Objects: sit at cell origin + optional z_level offset.
    for (const p of args.placements ?? []) {
        const worldX = (p.gridX - p.gridY) * (tileSize / 2);
        const worldY = (p.gridX + p.gridY) * (tileSize / 4);
        const z = p.zLevel ?? 0;
        const screenX = worldX + offsetX - p.width / 2 + tileSize / 2;
        const screenY = worldY + offsetY - p.height + tileSize / 2 - z * stackStep;
        const buf = await sharp(p.buffer).resize(p.width, p.height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
        composites.push({ input: buf, left: Math.round(screenX), top: Math.round(screenY) });
    }

    const base = sharp({
        create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    });
    return composites.length > 0 ? base.composite(composites).png().toBuffer() : base.png().toBuffer();
}

// ── Corner-grid helpers ──────────────────────────────────────────────

/**
 * Build a default corner grid filled with 'lower'. Caller can then paint
 * patches of 'upper' or 'transition' terrain.
 */
export function makeCornerGrid(gridW: number, gridH: number, defaultLabel: TerrainCorner = 'lower'): TerrainCorner[][] {
    const rows: TerrainCorner[][] = [];
    for (let y = 0; y <= gridH; y++) {
        const row: TerrainCorner[] = [];
        for (let x = 0; x <= gridW; x++) row.push(defaultLabel);
        rows.push(row);
    }
    return rows;
}

/**
 * Paint a rectangular island of `label` into the corner grid — so the
 * generated map isn't all one terrain out of the box. Size is derived from
 * grid dimensions so the island is always visible.
 */
export function paintStarterIsland(
    corners: TerrainCorner[][],
    gridW: number,
    gridH: number,
    label: TerrainCorner = 'upper',
): TerrainCorner[][] {
    const islandW = Math.max(2, Math.floor(gridW / 3));
    const islandH = Math.max(2, Math.floor(gridH / 3));
    const originX = Math.floor((gridW - islandW) / 2);
    const originY = Math.floor((gridH - islandH) / 2);
    for (let y = originY; y <= originY + islandH; y++) {
        for (let x = originX; x <= originX + islandW; x++) {
            if (y >= 0 && y < corners.length && x >= 0 && x < (corners[y]?.length ?? 0)) {
                corners[y][x] = label;
            }
        }
    }
    return corners;
}

// ── Iso grid fill (simple variant rotation) ──────────────────────────

/**
 * Fill an iso grid with the given tile ids rotating deterministically so
 * variants are spread out rather than clumped.
 */
export function fillIsoGrid(
    gridW: number,
    gridH: number,
    tileIds: string[],
): (string | null)[][] {
    if (tileIds.length === 0) {
        return Array.from({ length: gridH }, () => Array(gridW).fill(null));
    }
    const grid: (string | null)[][] = [];
    for (let y = 0; y < gridH; y++) {
        const row: (string | null)[] = [];
        for (let x = 0; x < gridW; x++) {
            // 6× weight on first tile ("ground"), rotate the rest.
            const r = (x * 7 + y * 13) % (tileIds.length + 5);
            row.push(r < 5 ? tileIds[0] : tileIds[(r - 5) % Math.max(1, tileIds.length - 1) + 1] ?? tileIds[0]);
        }
        grid.push(row);
    }
    return grid;
}
