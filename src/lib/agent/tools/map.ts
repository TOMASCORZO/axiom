/**
 * Map Studio tools — projection-aware generation.
 *
 *   - generate_map           Orchestrator; switches on `projection`:
 *                              * orthogonal → /create-tileset (Wang)
 *                              * isometric  → /create-tiles-pro (iso variants)
 *   - generate_map_object    One object sprite (/map-objects), optionally
 *                            style-locked to a background map.
 *   - generate_iso_tile      One isometric tile via /create-isometric-tile
 *                            (for painting extra variants into an iso map).
 */

import { getAdminClient as getAdmin } from '@/lib/supabase/admin';
import { registerTool, type ToolContext } from './registry';
import {
    generateWangTileset,
    generateIsoTiles,
    generateSingleIsoTile,
    generateMapObjectV2,
    makeCornerGrid,
    paintStarterIsland,
    fillIsoGrid,
    composeWangMap,
    composeIsoMap,
} from '@/lib/assets/map-generate';
import type {
    MapMetadataShape,
    MapWangTile,
    MapIsoTile,
    MapObjectEntry,
    MapProjection,
    TerrainCorner,
} from '@/types/asset';

// ── Storage helper ────────────────────────────────────────────────────

async function uploadBinaryAsset(
    ctx: ToolContext,
    path: string,
    buffer: Buffer,
    mimeType: string,
): Promise<string> {
    const storageKey = `projects/${ctx.userId}/${ctx.projectId}/${path}`;
    const admin = getAdmin();
    const { error } = await admin.storage
        .from('assets')
        .upload(storageKey, buffer, { contentType: mimeType, upsert: true });
    if (error) throw new Error(`Storage upload failed for ${path}: ${error.message}`);
    const { error: regErr } = await admin.from('project_files').upsert({
        project_id: ctx.projectId,
        path,
        content_type: 'binary',
        size_bytes: buffer.byteLength,
        storage_key: storageKey,
    }, { onConflict: 'project_id,path' });
    if (regErr) console.error(`[axiom] File registration failed for ${path}:`, regErr.message);
    return storageKey;
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'map';
}

// ── generate_map_object ───────────────────────────────────────────────

registerTool({
    name: 'generate_map_object',
    description: 'Generate one pixel-art map object (tree, rock, chest…) via PixelLab /map-objects. Transparent background. Optional style-match via background_map_path: pass a composed map storage path and the object will inpaint against it for palette consistency.',
    parameters: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: 'Object description' },
            tile_size: { type: 'integer', default: 32 },
            width_tiles: { type: 'integer', default: 1, description: 'How many tiles wide (1-4)' },
            height_tiles: { type: 'integer', default: 1 },
            view: { type: 'string', enum: ['low top-down', 'high top-down', 'side'], default: 'high top-down' },
            target_path: { type: 'string' },
            background_map_path: { type: 'string', description: 'Optional: storage path to a composed map PNG for style-match via inpainting.' },
        },
        required: ['prompt', 'target_path'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const prompt = input.prompt as string;
        const tileSize = (input.tile_size as number) || 32;
        const wTiles = (input.width_tiles as number) || 1;
        const hTiles = (input.height_tiles as number) || 1;
        const view = (input.view as 'low top-down' | 'high top-down' | 'side') || 'high top-down';
        const targetPath = input.target_path as string;
        const backgroundMapPath = input.background_map_path as string | undefined;

        let backgroundImageBase64: string | undefined;
        if (backgroundMapPath) {
            // Fetch the composed map PNG and hand it to the API as b64 for palette match.
            const admin = getAdmin();
            const storageKey = `projects/${ctx.userId}/${ctx.projectId}/${backgroundMapPath}`;
            const { data } = await admin.storage.from('assets').download(storageKey);
            if (data) {
                const ab = await data.arrayBuffer();
                backgroundImageBase64 = Buffer.from(ab).toString('base64');
            }
        }

        const result = await generateMapObjectV2({
            prompt,
            tileSize,
            widthTiles: wTiles,
            heightTiles: hTiles,
            view,
            backgroundImageBase64,
        });
        if (!result.success || !result.buffer) {
            return {
                callId: '', success: false,
                error: result.error || 'Object generation failed',
                output: { message: result.error },
                filesModified: [],
                duration_ms: Date.now() - start,
            };
        }
        const sk = await uploadBinaryAsset(ctx, targetPath, result.buffer, 'image/png');
        return {
            callId: '', success: true,
            output: {
                message: `Map object at ${targetPath} (${result.width}×${result.height})`,
                path: targetPath,
                storage_key: sk,
                width: result.width,
                height: result.height,
                cost: result.cost,
            },
            filesModified: [targetPath],
            duration_ms: Date.now() - start,
        };
    },
});

// ── generate_iso_tile (single) ────────────────────────────────────────

registerTool({
    name: 'generate_iso_tile',
    description: 'Generate one isometric pixel-art tile via PixelLab /create-isometric-tile. For painting extra variants into an isometric map.',
    parameters: {
        type: 'object',
        properties: {
            prompt: { type: 'string' },
            tile_size: { type: 'integer', enum: [16, 32], default: 32 },
            shape: { type: 'string', enum: ['thin tile', 'thick tile', 'block'], default: 'block' },
            target_path: { type: 'string' },
        },
        required: ['prompt', 'target_path'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const prompt = input.prompt as string;
        const tileSize = ((input.tile_size as number) === 16 ? 16 : 32) as 16 | 32;
        const shape = (input.shape as 'thin tile' | 'thick tile' | 'block') ?? 'block';
        const targetPath = input.target_path as string;

        const result = await generateSingleIsoTile({ prompt, tileSize, shape });
        if (!result.success || !result.buffer) {
            return {
                callId: '', success: false,
                error: result.error || 'Iso tile generation failed',
                output: { message: result.error },
                filesModified: [],
                duration_ms: Date.now() - start,
            };
        }
        const sk = await uploadBinaryAsset(ctx, targetPath, result.buffer, 'image/png');
        return {
            callId: '', success: true,
            output: {
                message: `Iso tile at ${targetPath} (${result.width}×${result.height})`,
                path: targetPath,
                storage_key: sk,
                width: result.width,
                height: result.height,
                cost: result.cost,
            },
            filesModified: [targetPath],
            duration_ms: Date.now() - start,
        };
    },
});

// ── generate_map (orchestrator) ───────────────────────────────────────

interface GenerateMapInput {
    prompt: string;
    projection?: MapProjection;
    // Orthogonal (Wang) inputs
    lower?: string;
    upper?: string;
    transition?: string;
    // Isometric inputs
    iso_variant_prompts?: string[];   // e.g. ["grass","dirt path","stone block"]
    // Shared
    tile_size?: number;
    grid_w?: number;
    grid_h?: number;
    mode?: 'fixed' | 'looping';
    target_path: string;
}

registerTool({
    name: 'generate_map',
    description: 'Generate a complete pixel-art map. For projection=orthogonal, calls PixelLab /create-tileset to get a 16-tile Wang set (lower terrain + upper terrain + optional transition) — the compositor auto-tiles so edges blend. For projection=isometric, calls /create-tiles-pro to get diamond-shaped tile variants and renders them in diamond projection. Stores full metadata so MapStudio can edit without re-generating.',
    parameters: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: 'Overall theme (used as a fallback when lower/upper/variants aren\'t given).' },
            projection: { type: 'string', enum: ['orthogonal', 'isometric'], default: 'orthogonal' },
            lower: { type: 'string', description: 'Orthogonal: lower/base terrain (e.g. "grass").' },
            upper: { type: 'string', description: 'Orthogonal: upper/elevated terrain (e.g. "stone path").' },
            transition: { type: 'string', description: 'Orthogonal: optional blend band description.' },
            iso_variant_prompts: { type: 'array', items: { type: 'string' }, description: 'Isometric: tile variant prompts (will be joined into one numbered description).' },
            tile_size: { type: 'integer', default: 32 },
            grid_w: { type: 'integer', default: 16 },
            grid_h: { type: 'integer', default: 12 },
            mode: { type: 'string', enum: ['fixed', 'looping'], default: 'fixed' },
            target_path: { type: 'string' },
        },
        required: ['prompt', 'target_path'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const data = input as unknown as GenerateMapInput;
        const projection: MapProjection = data.projection ?? 'orthogonal';
        const rawTileSize = data.tile_size ?? 32;
        const gridW = Math.max(4, Math.min(data.grid_w ?? 16, 64));
        const gridH = Math.max(4, Math.min(data.grid_h ?? 12, 64));
        const mode = data.mode ?? 'fixed';
        const targetPath = data.target_path;
        const basePromptSlug = slugify(data.prompt);
        let totalCost = 0;

        if (projection === 'orthogonal') {
            // Wang tileset path. Tile size is constrained to 16 or 32 by the API.
            const tileSize = rawTileSize <= 24 ? 16 : 32;
            const lower = data.lower ?? `${data.prompt} — ground`;
            const upper = data.upper ?? `${data.prompt} — path`;
            const transition = data.transition;

            const ts = await generateWangTileset({
                lower, upper, transition, tileSize,
                view: 'high top-down',
            });
            if (!ts.success) {
                return {
                    callId: '', success: false,
                    error: `Wang tileset failed: ${ts.error}`,
                    output: { message: ts.error },
                    filesModified: [],
                    duration_ms: Date.now() - start,
                };
            }
            totalCost += ts.cost;

            // Upload each Wang tile PNG and build library entries.
            const wangEntries: MapWangTile[] = [];
            const wangLookup: Array<{ id: string; buffer: Buffer; corners: MapWangTile['corners'] }> = [];
            for (let i = 0; i < ts.tiles.length; i++) {
                const t = ts.tiles[i];
                const tilePath = `assets/maps/${basePromptSlug}/wang/${i}_${t.pixellabId}.png`;
                const sk = await uploadBinaryAsset(ctx, tilePath, t.buffer, 'image/png');
                wangEntries.push({
                    id: t.pixellabId,
                    storage_key: sk,
                    corners: t.corners,
                    name: t.name || `wang_${i}`,
                });
                wangLookup.push({ id: t.pixellabId, buffer: t.buffer, corners: t.corners });
            }

            // Seed the corner grid with a starter island so the map shows both terrains.
            const corners = paintStarterIsland(
                makeCornerGrid(gridW, gridH, 'lower'),
                gridW, gridH, 'upper',
            );

            const composedBuf = await composeWangMap({
                tileSize, gridW, gridH, corners,
                wangTiles: wangLookup,
            });
            const composedSk = await uploadBinaryAsset(ctx, targetPath, composedBuf, 'image/png');

            const metadata: MapMetadataShape = {
                projection: 'orthogonal',
                tile_size: tileSize,
                grid_w: gridW,
                grid_h: gridH,
                mode,
                corners,
                wang_tiles: wangEntries,
                terrain_prompts: { lower, upper, transition },
                objects_library: [],
                placements: [],
            };

            return {
                callId: '', success: true,
                output: {
                    message: `Orthogonal Wang map generated at ${targetPath} (${gridW}×${gridH}, ${wangEntries.length} wang tiles, ~$${totalCost.toFixed(3)})`,
                    path: targetPath,
                    storage_key: composedSk,
                    width: gridW * tileSize,
                    height: gridH * tileSize,
                    map_metadata: metadata,
                    cost: totalCost,
                },
                filesModified: [targetPath],
                duration_ms: Date.now() - start,
            };
        }

        // ── Isometric path ──
        const tileSize = Math.max(16, Math.min(rawTileSize, 64));
        const variantPrompts = (data.iso_variant_prompts ?? [
            `${data.prompt} — ground`,
            `${data.prompt} — path`,
            `${data.prompt} — detail`,
        ]).slice(0, 6);

        // Build a single numbered description per tiles-pro convention.
        const description = variantPrompts.map((p, i) => `${i + 1}). ${p}`).join(' ');

        const iso = await generateIsoTiles({
            description,
            tileSize,
        });
        if (!iso.success) {
            return {
                callId: '', success: false,
                error: `Iso tiles failed: ${iso.error}`,
                output: { message: iso.error },
                filesModified: [],
                duration_ms: Date.now() - start,
            };
        }
        totalCost += iso.cost;

        const isoEntries: MapIsoTile[] = [];
        const isoBufById = new Map<string, Buffer>();
        for (let i = 0; i < iso.tiles.length; i++) {
            const t = iso.tiles[i];
            const id = `iso_${i}_${crypto.randomUUID().slice(0, 8)}`;
            const path = `assets/maps/${basePromptSlug}/iso/${i}.png`;
            const sk = await uploadBinaryAsset(ctx, path, t.buffer, 'image/png');
            isoEntries.push({
                id,
                storage_key: sk,
                name: variantPrompts[i] ?? `variant_${i}`,
                width: t.width,
                height: t.height,
            });
            isoBufById.set(id, t.buffer);
        }

        const isoGrid = fillIsoGrid(gridW, gridH, isoEntries.map(e => e.id));
        const tileBuffers: (Buffer | null)[][] = isoGrid.map(row =>
            row.map(id => (id ? isoBufById.get(id) ?? null : null)),
        );

        const composedBuf = await composeIsoMap({
            tileSize,
            gridW, gridH,
            tileBuffers,
            tileRenderWidth: isoEntries[0]?.width ?? tileSize * 2,
            tileRenderHeight: isoEntries[0]?.height ?? tileSize * 2,
        });
        const composedSk = await uploadBinaryAsset(ctx, targetPath, composedBuf, 'image/png');

        const metadata: MapMetadataShape = {
            projection: 'isometric',
            tile_size: tileSize,
            grid_w: gridW,
            grid_h: gridH,
            mode,
            iso_tiles: isoEntries,
            iso_grid: isoGrid,
            objects_library: [],
            placements: [],
        };

        return {
            callId: '', success: true,
            output: {
                message: `Isometric map generated at ${targetPath} (${gridW}×${gridH}, ${isoEntries.length} variants, ~$${totalCost.toFixed(3)})`,
                path: targetPath,
                storage_key: composedSk,
                width: (gridW + gridH) * (tileSize / 2),
                height: (gridW + gridH) * (tileSize / 4) + (isoEntries[0]?.height ?? tileSize * 2),
                map_metadata: metadata,
                cost: totalCost,
            },
            filesModified: [targetPath],
            duration_ms: Date.now() - start,
        };
    },
});

// Helper used by the map-action route — avoids circular imports by keeping it here.
export function newMapObjectEntry(args: { storage_key: string; name: string; width: number; height: number; prompt: string }): MapObjectEntry {
    return {
        id: `obj_${crypto.randomUUID().slice(0, 8)}`,
        storage_key: args.storage_key,
        name: args.name,
        width: args.width,
        height: args.height,
        prompt: args.prompt,
    };
}

// Re-export TerrainCorner for convenience.
export type { TerrainCorner };
