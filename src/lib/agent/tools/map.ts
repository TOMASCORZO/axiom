/**
 * Map Studio tools — decomposed per design:
 *   - generate_tile         : one single tile sprite
 *   - generate_map_object   : one single object sprite (placed on tiles)
 *   - generate_map          : orchestrator — N tiles + optional objects,
 *                             random-fill grid, compose PNG, create map asset
 *
 * The map asset stores grid + library in metadata.map so MapStudio can
 * re-render/edit without re-generating sprites.
 */

import { getAdminClient as getAdmin } from '@/lib/supabase/admin';
import { registerTool, type ToolContext } from './registry';
import {
    generateSingleTile,
    generateMapObject,
    composeMap,
    fillGridRandomly,
    type ComposeTile,
} from '@/lib/assets/map-generate';
import type {
    MapMetadataShape,
    MapTileEntry,
    MapObjectEntry,
} from '@/types/asset';

// ── Storage helper ────────────────────────────────────────────────────

async function uploadBinaryAsset(
    ctx: ToolContext,
    path: string,
    buffer: ArrayBuffer,
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

function toArrayBuffer(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'tile';
}

// ── generate_tile ─────────────────────────────────────────────────────

registerTool({
    name: 'generate_tile',
    description: 'Generate a single pixel-art map tile via PixelLab (top-down, seamless).',
    parameters: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: 'Tile description (e.g. "grass with flowers", "cobblestone path", "dark water")' },
            tile_size: { type: 'integer', default: 32, description: 'Tile size in px (16-64)' },
            target_path: { type: 'string', description: 'Storage path, e.g. assets/tiles/grass.png' },
            seamless: { type: 'boolean', default: true },
        },
        required: ['prompt', 'target_path'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const prompt = input.prompt as string;
        const tileSize = (input.tile_size as number) || 32;
        const targetPath = input.target_path as string;
        const seamless = input.seamless !== false;

        const result = await generateSingleTile({ prompt, tileSize, seamless });
        if (!result.success || !result.buffer) {
            return {
                callId: '', success: false,
                error: result.error || 'Tile generation failed',
                output: { message: result.error },
                filesModified: [],
                duration_ms: Date.now() - start,
            };
        }
        const sk = await uploadBinaryAsset(ctx, targetPath, result.buffer, 'image/png');
        return {
            callId: '', success: true,
            output: {
                message: `Tile generated at ${targetPath} (${tileSize}×${tileSize})`,
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

// ── generate_map_object ───────────────────────────────────────────────

registerTool({
    name: 'generate_map_object',
    description: 'Generate a single pixel-art map object sprite (tree, rock, chest…) sized to sit on 1-4 tiles. Transparent background.',
    parameters: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: 'Object description' },
            tile_size: { type: 'integer', default: 32 },
            width_tiles: { type: 'integer', default: 1, description: 'How many tiles wide the object occupies (1-4)' },
            height_tiles: { type: 'integer', default: 1 },
            target_path: { type: 'string' },
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
        const targetPath = input.target_path as string;

        const result = await generateMapObject({
            prompt, tileSize,
            widthTiles: wTiles,
            heightTiles: hTiles,
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

// ── generate_map (orchestrator) ───────────────────────────────────────

interface GenerateMapInput {
    prompt: string;
    tile_prompts?: string[];
    object_prompts?: string[];
    tile_size?: number;
    grid_w?: number;
    grid_h?: number;
    mode?: 'fixed' | 'looping';
    target_path: string;
}

registerTool({
    name: 'generate_map',
    description: 'Generate a complete pixel-art map: generates N tile sprites (default 3 derived from the theme), optionally N object sprites, then random-fills a grid and composes a PNG. Stores the full tile library + grid in metadata so it stays editable in MapStudio.',
    parameters: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: 'Overall map theme, e.g. "grassy meadow with dirt paths"' },
            tile_prompts: {
                type: 'array',
                items: { type: 'string' },
                description: 'Explicit tile prompts. Defaults to 3 generic tiles derived from `prompt` if omitted.',
            },
            object_prompts: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional list of map object prompts (trees, rocks, etc.). Objects are NOT auto-placed — they go into the library.',
            },
            tile_size: { type: 'integer', default: 32 },
            grid_w: { type: 'integer', default: 16 },
            grid_h: { type: 'integer', default: 12 },
            mode: { type: 'string', enum: ['fixed', 'looping'], default: 'fixed' },
            target_path: { type: 'string', description: 'Storage path for the composed map PNG, e.g. assets/maps/meadow.png' },
        },
        required: ['prompt', 'target_path'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const data = input as unknown as GenerateMapInput;
        const tileSize = Math.max(16, Math.min(data.tile_size ?? 32, 64));
        const gridW = Math.max(4, Math.min(data.grid_w ?? 16, 64));
        const gridH = Math.max(4, Math.min(data.grid_h ?? 12, 64));
        const mode = data.mode ?? 'fixed';
        const targetPath = data.target_path;
        const basePromptSlug = slugify(data.prompt);

        // Derive default tile prompts if none provided.
        const tilePrompts = data.tile_prompts && data.tile_prompts.length > 0
            ? data.tile_prompts.slice(0, 6)
            : [
                `${data.prompt} — ground`,
                `${data.prompt} — path`,
                `${data.prompt} — obstacle`,
            ];
        const objectPrompts = (data.object_prompts ?? []).slice(0, 6);

        // Generate tiles sequentially (PixelLab GPU hates parallel bursts).
        const tileEntries: MapTileEntry[] = [];
        const tileBuffers: ComposeTile[] = [];
        let totalCost = 0;

        for (let i = 0; i < tilePrompts.length; i++) {
            const p = tilePrompts[i];
            const tileId = crypto.randomUUID();
            const tileSlug = slugify(p);
            const tilePath = `assets/maps/${basePromptSlug}/tiles/${i}_${tileSlug}.png`;
            const r = await generateSingleTile({ prompt: p, tileSize, seamless: true });
            if (!r.success || !r.buffer) {
                return {
                    callId: '', success: false,
                    error: `Tile ${i + 1}/${tilePrompts.length} failed: ${r.error}`,
                    output: { message: r.error },
                    filesModified: [],
                    duration_ms: Date.now() - start,
                };
            }
            totalCost += r.cost;
            const sk = await uploadBinaryAsset(ctx, tilePath, r.buffer, 'image/png');
            tileEntries.push({
                id: tileId,
                storage_key: sk,
                name: p.slice(0, 30),
                prompt: p,
            });
            tileBuffers.push({ id: tileId, buffer: Buffer.from(r.buffer) });
        }

        // Generate optional objects into the library (not auto-placed).
        const objectEntries: MapObjectEntry[] = [];
        for (let i = 0; i < objectPrompts.length; i++) {
            const p = objectPrompts[i];
            const objId = crypto.randomUUID();
            const objSlug = slugify(p);
            const objPath = `assets/maps/${basePromptSlug}/objects/${i}_${objSlug}.png`;
            const r = await generateMapObject({ prompt: p, tileSize });
            if (!r.success || !r.buffer) continue; // skip failures — library is optional
            totalCost += r.cost;
            const sk = await uploadBinaryAsset(ctx, objPath, r.buffer, 'image/png');
            objectEntries.push({
                id: objId,
                storage_key: sk,
                name: p.slice(0, 30),
                width: r.width ?? tileSize,
                height: r.height ?? tileSize,
                prompt: p,
            });
        }

        // Random-fill the grid using the generated tile palette.
        const grid = fillGridRandomly(gridW, gridH, tileEntries.map(t => t.id));

        // Compose the PNG snapshot.
        const composedBuf = await composeMap({
            tileSize,
            gridW,
            gridH,
            grid,
            tiles: tileBuffers,
            placements: [],
        });
        const composedStorageKey = await uploadBinaryAsset(
            ctx,
            targetPath,
            toArrayBuffer(composedBuf),
            'image/png',
        );

        const metadata: MapMetadataShape = {
            tile_size: tileSize,
            grid_w: gridW,
            grid_h: gridH,
            mode,
            tiles: tileEntries,
            objects_library: objectEntries,
            grid,
            placements: [],
        };

        return {
            callId: '', success: true,
            output: {
                message: `Map generated at ${targetPath} (${gridW}×${gridH} tiles, ${tileEntries.length} variants, ${objectEntries.length} objects, ~$${totalCost.toFixed(3)})`,
                path: targetPath,
                storage_key: composedStorageKey,
                width: gridW * tileSize,
                height: gridH * tileSize,
                map_metadata: metadata,
                cost: totalCost,
            },
            filesModified: [targetPath],
            duration_ms: Date.now() - start,
        };
    },
});
