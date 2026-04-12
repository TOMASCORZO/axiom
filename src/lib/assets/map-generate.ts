/**
 * Map Studio backend — tile/object generation + Sharp composition.
 *
 * Intentionally does NOT use PixelLab /create-tileset (Wang) or /map-objects.
 * Those endpoints return opaque blobs that are hard to pair with a user-editable
 * grid. We generate individual tile sprites with /create-image-pixflux (same
 * path as generate_sprite) and let the editor paint them onto cells.
 */

import { generate2D } from './generate';

export interface SingleTileOptions {
    prompt: string;
    tileSize: number;        // 16-64 recommended
    seamless?: boolean;      // add hint to prompt
}

export interface SingleTileResult {
    success: boolean;
    buffer?: ArrayBuffer;
    width?: number;
    height?: number;
    cost: number;
    error?: string;
}

/**
 * Generate a single map tile sprite. Hints PixelLab toward a seamless,
 * top-down pixel-art tile at the requested size.
 */
export async function generateSingleTile(opts: SingleTileOptions): Promise<SingleTileResult> {
    const size = Math.max(16, Math.min(opts.tileSize, 64));
    const seamlessHint = opts.seamless !== false
        ? ' — seamless tileable top-down pixel-art tile, no border, no shadow'
        : ' — top-down pixel-art tile';
    const result = await generate2D({
        prompt: `${opts.prompt}${seamlessHint}`,
        width: size,
        height: size,
        noBackground: false, // tiles are solid, not transparent
        view: 'high top-down',
    });
    if (!result.success || !result.buffer) {
        return { success: false, cost: 0, error: result.error || 'Tile generation failed' };
    }
    return {
        success: true,
        buffer: result.buffer,
        width: size,
        height: size,
        cost: result.cost,
    };
}

export interface MapObjectOptions {
    prompt: string;
    tileSize: number;
    widthTiles?: number;     // object can span multiple tiles (default 1)
    heightTiles?: number;
}

export interface MapObjectResult {
    success: boolean;
    buffer?: ArrayBuffer;
    width?: number;
    height?: number;
    cost: number;
    error?: string;
}

/**
 * Generate a map object sprite (tree, rock, chest, character etc.) sized to
 * sit on top of one or more tiles. Always transparent background.
 */
export async function generateMapObject(opts: MapObjectOptions): Promise<MapObjectResult> {
    const tileSize = Math.max(16, Math.min(opts.tileSize, 64));
    const wTiles = Math.max(1, Math.min(opts.widthTiles ?? 1, 4));
    const hTiles = Math.max(1, Math.min(opts.heightTiles ?? 1, 4));
    const width = tileSize * wTiles;
    const height = tileSize * hTiles;

    const result = await generate2D({
        prompt: `${opts.prompt} — pixel-art top-down map object, centered, transparent background`,
        width,
        height,
        noBackground: true,
        view: 'high top-down',
    });
    if (!result.success || !result.buffer) {
        return { success: false, cost: 0, error: result.error || 'Object generation failed' };
    }
    return {
        success: true,
        buffer: result.buffer,
        width,
        height,
        cost: result.cost,
    };
}

// ── Compose a map image from a tile grid + object placements ──────────

export interface ComposeTile {
    id: string;
    buffer: Buffer;
}

export interface ComposePlacement {
    buffer: Buffer;
    gridX: number;
    gridY: number;
    width: number;
    height: number;
}

export interface ComposeMapArgs {
    tileSize: number;
    gridW: number;
    gridH: number;
    grid: (string | null)[][];   // grid[y][x] → tile id or null
    tiles: ComposeTile[];
    placements: ComposePlacement[];
}

/**
 * Compose a PNG buffer from the tile grid + object placements. The returned
 * image is gridW*tileSize × gridH*tileSize. Empty cells render as transparent.
 * Objects are drawn on top of tiles in placement order.
 */
export async function composeMap(args: ComposeMapArgs): Promise<Buffer> {
    const sharp = (await import('sharp')).default;
    const { tileSize, gridW, gridH, grid, tiles, placements } = args;

    const canvasW = tileSize * gridW;
    const canvasH = tileSize * gridH;

    const tileMap = new Map<string, Buffer>();
    for (const t of tiles) tileMap.set(t.id, t.buffer);

    // Normalize every tile buffer to exactly tileSize × tileSize up front so we
    // can feed a single composite call. Sharp's composite will reject images
    // that don't match the declared input size.
    const normalizedTiles = new Map<string, Buffer>();
    for (const [id, buf] of tileMap.entries()) {
        const normalized = await sharp(buf)
            .resize(tileSize, tileSize, { fit: 'fill' })
            .png()
            .toBuffer();
        normalizedTiles.set(id, normalized);
    }

    const composites: Array<{ input: Buffer; left: number; top: number }> = [];

    for (let y = 0; y < gridH; y++) {
        const row = grid[y];
        if (!row) continue;
        for (let x = 0; x < gridW; x++) {
            const id = row[x];
            if (!id) continue;
            const buf = normalizedTiles.get(id);
            if (!buf) continue;
            composites.push({
                input: buf,
                left: x * tileSize,
                top: y * tileSize,
            });
        }
    }

    for (const p of placements) {
        const buf = await sharp(p.buffer)
            .resize(p.width, p.height, { fit: 'fill' })
            .png()
            .toBuffer();
        composites.push({
            input: buf,
            left: p.gridX * tileSize,
            top: p.gridY * tileSize,
        });
    }

    const base = sharp({
        create: {
            width: canvasW,
            height: canvasH,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    });

    const out = composites.length > 0
        ? await base.composite(composites).png().toBuffer()
        : await base.png().toBuffer();

    return out;
}

// ── Random-fill helper (used by generate_map orchestrator) ────────────

/**
 * Fill an empty grid with the given tile ids using a simple weighted random
 * distribution. The first tile is treated as the "ground" (heaviest weight)
 * so that sparse detail tiles don't flood the map.
 */
export function fillGridRandomly(
    gridW: number,
    gridH: number,
    tileIds: string[],
): (string | null)[][] {
    if (tileIds.length === 0) {
        return Array.from({ length: gridH }, () => Array(gridW).fill(null));
    }
    const weights = tileIds.map((_, i) => (i === 0 ? 6 : 1));
    const total = weights.reduce((a, b) => a + b, 0);

    const grid: (string | null)[][] = [];
    for (let y = 0; y < gridH; y++) {
        const row: (string | null)[] = [];
        for (let x = 0; x < gridW; x++) {
            let r = Math.random() * total;
            let picked = tileIds[0];
            for (let i = 0; i < tileIds.length; i++) {
                r -= weights[i];
                if (r <= 0) { picked = tileIds[i]; break; }
            }
            row.push(picked);
        }
        grid.push(row);
    }
    return grid;
}
