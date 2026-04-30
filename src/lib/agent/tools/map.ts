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
    generateTilesPro,
    generateSingleIsoTile,
    generateMapObjectV2,
    makeCornerGrid,
    paintStarterIsland,
    fillIsoGrid,
    composeWangMap,
    composeIsoMap,
    type GenerateMapObjectOptions,
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

// Register a map in the `assets` table so MapStudio Gallery can pick it up
// and open it. Without this row, agent-generated maps are only visible as
// raw PNGs in the FileTree / AssetStudio preview.
async function registerMapAsset(
    ctx: ToolContext,
    params: {
        storageKey: string;
        name: string;
        prompt: string;
        width: number;
        height: number;
        sizeBytes: number;
        metadata: MapMetadataShape;
    },
): Promise<{ id: string; metadata: MapMetadataShape }> {
    const admin = getAdmin();
    const id = crypto.randomUUID();
    // Seed version=1 so the optimistic-concurrency CAS in /map-action [recompose]
    // has a baseline. Maps created before this field existed read back as
    // undefined → the recompose handler coerces to 0 for the comparison.
    const metadataWithVersion: MapMetadataShape = { ...params.metadata, version: 1 };
    const { error } = await admin.from('assets').upsert({
        id,
        project_id: ctx.projectId,
        name: params.name,
        asset_type: 'map',
        storage_key: params.storageKey,
        thumbnail_key: null,
        file_format: 'png',
        width: params.width,
        height: params.height,
        metadata: { map: metadataWithVersion, tags: ['map'] },
        generation_prompt: params.prompt,
        generation_model: 'pixellab-map',
        size_bytes: params.sizeBytes,
    }, { onConflict: 'id' });
    if (error) {
        // Propagate so the agent + UI can see it. The most common cause is an
        // outdated assets.asset_type CHECK constraint — run migration
        // `supabase/migrations/006_map_asset_type.sql` against the DB to fix.
        console.error(`[axiom] Map asset registration failed:`, error.message);
        throw new Error(
            `Map generated but could not be registered in the assets table: ${error.message}. ` +
            `If this mentions asset_type, apply migration 006_map_asset_type.sql.`,
        );
    }
    return { id, metadata: metadataWithVersion };
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'map';
}

// ── generate_map_object ───────────────────────────────────────────────

registerTool({
    name: 'generate_map_object',
    description: 'Generate one pixel-art map object (tree, rock, chest…) via PixelLab /map-objects. Transparent background. Optional style-match via background_map_path: pass a composed map storage path and the object will inpaint against it for palette consistency. Optional inpaint_region restricts generation to a sub-area of the background — use it to edit a specific spot of the map without re-generating the whole thing.',
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
            seed: { type: 'integer', description: 'Optional deterministic seed.' },
            text_guidance_scale: { type: 'number', description: '1–20. Higher = stick closer to prompt; lower = more creative.' },
            inpaint_region: {
                type: 'object',
                description: 'Optional: restrict generation to a sub-area of the background_map_path image. Pixel coords. Requires background_map_path. Use this OR mask_path, not both.',
                properties: {
                    shape: { type: 'string', enum: ['oval', 'rectangle'], default: 'rectangle' },
                    x: { type: 'integer' },
                    y: { type: 'integer' },
                    width: { type: 'integer' },
                    height: { type: 'integer' },
                },
                required: ['x', 'y', 'width', 'height'],
            },
            mask_path: { type: 'string', description: 'Optional: storage path to a black/white PNG mask (white = paint-here, black = leave-untouched). Same dimensions as background_map_path. Use this for arbitrary-shape regions; use inpaint_region for simple rectangles/ovals. Requires background_map_path.' },
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
        const seed = input.seed as number | undefined;
        const textGuidanceScale = input.text_guidance_scale as number | undefined;
        const inpaintRegion = input.inpaint_region as
            | { shape?: 'oval' | 'rectangle'; x: number; y: number; width: number; height: number }
            | undefined;
        const maskPath = input.mask_path as string | undefined;

        const admin = getAdmin();
        const downloadAsB64 = async (path: string): Promise<string | undefined> => {
            const storageKey = `projects/${ctx.userId}/${ctx.projectId}/${path}`;
            const { data } = await admin.storage.from('assets').download(storageKey);
            if (!data) return undefined;
            const ab = await data.arrayBuffer();
            return Buffer.from(ab).toString('base64');
        };

        let backgroundImageBase64: string | undefined;
        if (backgroundMapPath) backgroundImageBase64 = await downloadAsB64(backgroundMapPath);

        let maskInpainting: { type: 'mask'; mask_base64: string } | undefined;
        if (maskPath && backgroundImageBase64) {
            const maskB64 = await downloadAsB64(maskPath);
            if (maskB64) maskInpainting = { type: 'mask', mask_base64: maskB64 };
        }

        // mask_path takes precedence over inpaint_region when both are provided.
        const inpainting: GenerateMapObjectOptions['inpainting'] = maskInpainting
            ?? (inpaintRegion && backgroundImageBase64
                ? {
                      type: inpaintRegion.shape ?? 'rectangle',
                      x: inpaintRegion.x,
                      y: inpaintRegion.y,
                      w: inpaintRegion.width,
                      h: inpaintRegion.height,
                  }
                : undefined);

        const result = await generateMapObjectV2({
            prompt,
            tileSize,
            widthTiles: wTiles,
            heightTiles: hTiles,
            view,
            backgroundImageBase64,
            seed,
            textGuidanceScale,
            inpainting,
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
            seed: { type: 'integer', description: 'Optional deterministic seed.' },
            text_guidance_scale: { type: 'number', description: '1–20. Higher = stick closer to prompt; lower = more creative.' },
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
        const seed = input.seed as number | undefined;
        const textGuidanceScale = input.text_guidance_scale as number | undefined;

        const result = await generateSingleIsoTile({ prompt, tileSize, shape, seed, textGuidanceScale });
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
    transition_size?: 0 | 0.25 | 0.5 | 0.75 | 1.0;
    outline?: string;
    shading?: string;
    detail?: string;
    // Isometric inputs
    iso_variant_prompts?: string[];   // e.g. ["grass","dirt path","stone block"]
    iso_tile_height?: number;         // explicit pixel height (16-256) — makes taller blocks
    iso_tile_view?: 'top-down' | 'high top-down' | 'low top-down' | 'side';
    iso_tile_view_angle?: number;     // 0–90deg, overrides iso_tile_view
    iso_depth_ratio?: number;         // 0.0 flat → 1.0 full block height
    // Shared
    tile_size?: number;
    grid_w?: number;
    grid_h?: number;
    mode?: 'fixed' | 'looping';
    seed?: number;
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
            transition_size: { type: 'number', enum: [0, 0.25, 0.5, 0.75, 1.0], description: 'Orthogonal: width of the blended transition band (0=none, 1=full tile). Defaults to 0.5 when transition is set.' },
            outline: { type: 'string', description: 'Orthogonal art-direction: free-text outline style (e.g. "thin black outline", "no outline").' },
            shading: { type: 'string', description: 'Orthogonal art-direction: free-text shading style (e.g. "soft shading", "hard pillow shading").' },
            detail: { type: 'string', description: 'Orthogonal art-direction: free-text detail level (e.g. "low detail", "high detail").' },
            iso_variant_prompts: { type: 'array', items: { type: 'string' }, description: 'Isometric: tile variant prompts (up to 16). Will be joined into one numbered description.' },
            iso_tile_height: { type: 'integer', description: 'Isometric: explicit tile pixel height (16-256). Makes tiles render as tall blocks — e.g. 2× tile_size for a proper cube.' },
            iso_tile_view: { type: 'string', enum: ['top-down', 'high top-down', 'low top-down', 'side'], description: 'Isometric: view preset controlling implicit depth. top-down=flat, side=~50% depth.' },
            iso_tile_view_angle: { type: 'number', description: 'Isometric: continuous view angle 0–90deg. Overrides iso_tile_view when set.' },
            iso_depth_ratio: { type: 'number', description: 'Isometric: 0.0 (flat) → 1.0 (full block). Overrides iso_tile_view\'s default depth.' },
            tile_size: { type: 'integer', default: 32, description: 'Tile footprint in pixels. Wang is API-limited to 16 or 32; iso supports 16–64.' },
            grid_w: { type: 'integer', default: 16, description: 'Cell columns (4–128).' },
            grid_h: { type: 'integer', default: 12, description: 'Cell rows (4–128).' },
            mode: { type: 'string', enum: ['fixed', 'looping'], default: 'fixed' },
            seed: { type: 'integer', description: 'Optional deterministic seed — pass the same seed to reproduce a generation.' },
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
        // Cap raised from 64 → 128 cells per side. Past ~128 the composed PNG
        // climbs into multi-megapixel territory; bump again only after profiling
        // sharp memory + asset storage limits.
        const gridW = Math.max(4, Math.min(data.grid_w ?? 16, 128));
        const gridH = Math.max(4, Math.min(data.grid_h ?? 12, 128));
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
                seed: data.seed,
                transitionSize: data.transition_size,
                outline: data.outline,
                shading: data.shading,
                detail: data.detail,
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

            const registered = await registerMapAsset(ctx, {
                storageKey: composedSk,
                name: data.prompt.slice(0, 40),
                prompt: data.prompt,
                width: gridW * tileSize,
                height: gridH * tileSize,
                sizeBytes: composedBuf.byteLength,
                metadata,
            });

            return {
                callId: '', success: true,
                output: {
                    message: `Orthogonal Wang map generated at ${targetPath} (${gridW}×${gridH}, ${wangEntries.length} wang tiles, ~$${totalCost.toFixed(3)})`,
                    path: targetPath,
                    storage_key: composedSk,
                    asset_id: registered.id,
                    width: gridW * tileSize,
                    height: gridH * tileSize,
                    map_metadata: registered.metadata,
                    cost: totalCost,
                },
                filesModified: [targetPath],
                duration_ms: Date.now() - start,
            };
        }

        // ── Isometric path ──
        const tileSize = Math.max(16, Math.min(rawTileSize, 64));
        // Variant cap raised from 6 → 16. /create-tiles-pro accepts arbitrary
        // counts via the numbered description; 16 keeps the composite legible
        // and the cost bounded.
        const variantPrompts = (data.iso_variant_prompts ?? [
            `${data.prompt} — ground`,
            `${data.prompt} — path`,
            `${data.prompt} — detail`,
        ]).slice(0, 16);

        // Build a single numbered description per tiles-pro convention.
        const description = variantPrompts.map((p, i) => `${i + 1}). ${p}`).join(' ');

        const iso = await generateIsoTiles({
            description,
            tileSize,
            tileHeight: data.iso_tile_height,
            tileView: data.iso_tile_view,
            tileViewAngle: data.iso_tile_view_angle,
            tileDepthRatio: data.iso_depth_ratio,
            seed: data.seed,
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
        // Build the initial iso_stack from the single-layer fill — one tile per
        // cell, ground level only. The user can stack more layers in MapStudio.
        const isoStack: string[][][] = isoGrid.map(row =>
            row.map(id => (id ? [id] : [])),
        );
        const tileStack: (Buffer | null)[][][] = isoStack.map(row =>
            row.map(ids => ids.map(id => isoBufById.get(id) ?? null)),
        );

        // Uniform render size: tallest variant drives height so none clip;
        // width from tile[0] (per-tile horizontal centering in the compositor).
        const renderW = isoEntries[0]?.width ?? tileSize * 2;
        const renderH = isoEntries.reduce((m, e) => Math.max(m, e.height), 0) || tileSize * 2;
        const composedBuf = await composeIsoMap({
            tileSize,
            gridW, gridH,
            tileStack,
            tileRenderWidth: renderW,
            tileRenderHeight: renderH,
        });
        const composedSk = await uploadBinaryAsset(ctx, targetPath, composedBuf, 'image/png');

        const metadata: MapMetadataShape = {
            projection: 'isometric',
            tile_size: tileSize,
            grid_w: gridW,
            grid_h: gridH,
            mode,
            iso_tiles: isoEntries,
            iso_stack: isoStack,
            objects_library: [],
            placements: [],
        };

        // Match composeIsoMap's canvas: diamond extents + tile_size/2 bottom
        // margin + top overhang for tall blocks. Initial generation is a
        // single stack level so stackHeadroom = 0.
        const topOverhang = Math.max(0, renderH - tileSize / 2);
        const outW = Math.ceil((gridW + gridH) * (tileSize / 2) + renderW);
        const outH = Math.ceil((gridW + gridH) * (tileSize / 4) + tileSize / 2 + topOverhang);
        const registered = await registerMapAsset(ctx, {
            storageKey: composedSk,
            name: data.prompt.slice(0, 40),
            prompt: data.prompt,
            width: Math.ceil(outW),
            height: Math.ceil(outH),
            sizeBytes: composedBuf.byteLength,
            metadata,
        });

        return {
            callId: '', success: true,
            output: {
                message: `Isometric map generated at ${targetPath} (${gridW}×${gridH}, ${isoEntries.length} variants, ~$${totalCost.toFixed(3)})`,
                path: targetPath,
                storage_key: composedSk,
                asset_id: registered.id,
                width: outW,
                height: outH,
                map_metadata: registered.metadata,
                cost: totalCost,
            },
            filesModified: [targetPath],
            duration_ms: Date.now() - start,
        };
    },
});

// ── generate_tileset (raw, shape-generic) ─────────────────────────────
//
// Exposes /create-tiles-pro for ALL shapes (isometric/hex/hex_pointy/octagon/
// square_topdown). Unlike generate_map this does NOT compose a single PNG —
// hex/octagon/square need shape-specific layout. We just return the N tile
// PNGs as individual assets so the agent can use them as raw building blocks.

registerTool({
    name: 'generate_tileset',
    description: 'Generate N pixel-art tiles in any shape (hex / hex_pointy / octagon / square_topdown / isometric) via PixelLab /create-tiles-pro. Returns one PNG per variant. Does NOT compose a final map — use this when you need raw tiles to assemble yourself, or for non-isometric/non-Wang projections that generate_map can\'t handle. For a ready-to-use map prefer generate_map instead.',
    parameters: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: 'Overall theme; used as fallback when variant_prompts is empty.' },
            variant_prompts: { type: 'array', items: { type: 'string' }, description: 'Up to 16 numbered variant prompts (e.g. ["grass","stone","water"]).' },
            shape: { type: 'string', enum: ['isometric', 'hex', 'hex_pointy', 'octagon', 'square_topdown'], default: 'hex' },
            tile_size: { type: 'integer', default: 32, description: 'Tile footprint width 16–256.' },
            tile_height: { type: 'integer', description: 'Optional explicit tile pixel height (16–256).' },
            tile_view: { type: 'string', enum: ['top-down', 'high top-down', 'low top-down', 'side'] },
            tile_view_angle: { type: 'number', description: '0–90deg, overrides tile_view.' },
            tile_depth_ratio: { type: 'number', description: '0.0 flat → 1.0 full block.' },
            seed: { type: 'integer' },
            target_dir: { type: 'string', description: 'Storage directory under assets/ where tile PNGs will land. Tiles are written as {target_dir}/{i}.png.' },
        },
        required: ['prompt', 'target_dir'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const prompt = input.prompt as string;
        const rawVariants = (input.variant_prompts as string[] | undefined) ?? [
            `${prompt} — variant 1`,
            `${prompt} — variant 2`,
            `${prompt} — variant 3`,
        ];
        const variantPrompts = rawVariants.slice(0, 16);
        const shape = (input.shape as 'isometric' | 'hex' | 'hex_pointy' | 'octagon' | 'square_topdown') ?? 'hex';
        const tileSize = Math.max(16, Math.min((input.tile_size as number) ?? 32, 256));
        const targetDir = (input.target_dir as string).replace(/\/+$/, '');
        const description = variantPrompts.map((p, i) => `${i + 1}). ${p}`).join(' ');

        const result = await generateTilesPro({
            description,
            tileType: shape,
            tileSize,
            tileHeight: input.tile_height as number | undefined,
            tileView: input.tile_view as 'top-down' | 'high top-down' | 'low top-down' | 'side' | undefined,
            tileViewAngle: input.tile_view_angle as number | undefined,
            tileDepthRatio: input.tile_depth_ratio as number | undefined,
            seed: input.seed as number | undefined,
        });
        if (!result.success) {
            return {
                callId: '', success: false,
                error: `Tileset failed: ${result.error}`,
                output: { message: result.error },
                filesModified: [],
                duration_ms: Date.now() - start,
            };
        }

        const tilePaths: string[] = [];
        for (let i = 0; i < result.tiles.length; i++) {
            const t = result.tiles[i];
            const path = `${targetDir}/${i}.png`;
            await uploadBinaryAsset(ctx, path, t.buffer, 'image/png');
            tilePaths.push(path);
        }

        return {
            callId: '', success: true,
            output: {
                message: `Generated ${tilePaths.length} ${shape} tiles in ${targetDir}/ (~$${result.cost.toFixed(3)})`,
                shape,
                tile_size: tileSize,
                tile_paths: tilePaths,
                count: tilePaths.length,
                cost: result.cost,
            },
            filesModified: tilePaths,
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
