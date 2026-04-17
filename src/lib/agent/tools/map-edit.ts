/**
 * Map editing tools — let the agent mutate existing map metadata without
 * going through the MapStudio UI. Pairs with generation tools in map.ts.
 *
 * Design principles:
 *   1. Tools edit metadata.map JSONB in place; they DO NOT recompose the
 *      composed PNG (recompose takes ~30s). The agent calls `recompose_map`
 *      explicitly once it's done editing.
 *   2. Every edit is an optimistic-concurrency CAS (SELECT current version →
 *      UPDATE WHERE version = current). Concurrent saves from MapStudio or
 *      a parallel agent can't silently overwrite each other.
 *   3. Granularity is regions, not single cells — minimises round-trips and
 *      lets the agent paint/fill large areas in one call.
 */

import { registerTool, type ToolContext } from './registry';
import { getAdminClient as getAdmin } from '@/lib/supabase/admin';
import type { ToolResult } from '@/types/agent';
import type {
    MapMetadataShape,
    MapIsoTile,
    MapObjectEntry,
    MapObjectPlacement,
    TerrainCorner,
} from '@/types/asset';
import {
    tryParseMapMetadata,
    sanitizePlacements,
    MAX_GRID_DIMENSION,
} from '@/lib/map-schema';
import type { MapLayer, LayerKind } from '@/types/asset';
import {
    generateSingleIsoTile,
    generateMapObjectV2,
    composeWangMap,
    composeIsoMap,
} from '@/lib/assets/map-generate';

// ── Shared helpers ────────────────────────────────────────────────────

interface LoadedMap {
    assetId: string;
    name: string;
    storageKey: string | null;
    metadata: MapMetadataShape;
    /** Current version in DB (0 if the row predates the version field). */
    version: number;
}

/** Load a map asset + its metadata. Throws on not-found or invalid shape. */
async function loadMap(assetId: string, projectId: string): Promise<LoadedMap> {
    const admin = getAdmin();
    const { data: row, error } = await admin
        .from('assets')
        .select('id, name, storage_key, project_id, asset_type, metadata')
        .eq('id', assetId)
        .single();
    if (error || !row) {
        throw new Error(`Map asset not found: ${assetId}`);
    }
    if (row.project_id !== projectId) {
        throw new Error(`Map asset ${assetId} does not belong to project ${projectId}`);
    }
    if (row.asset_type !== 'map') {
        throw new Error(`Asset ${assetId} is not a map (type=${row.asset_type})`);
    }
    const raw = (row.metadata as { map?: unknown } | null)?.map;
    const parsed = tryParseMapMetadata(raw);
    if (!parsed.ok) {
        throw new Error(`Stored map metadata is invalid: ${parsed.error}`);
    }
    return {
        assetId: row.id,
        name: row.name,
        storageKey: row.storage_key,
        metadata: parsed.value,
        version: parsed.value.version ?? 0,
    };
}

/** Atomic CAS write. Throws on 409 so the tool surfaces a clear error to the agent. */
async function saveMapMetadata(
    assetId: string,
    expectedVersion: number,
    newMetadata: MapMetadataShape,
): Promise<number> {
    const admin = getAdmin();
    const newVersion = expectedVersion + 1;
    const toWrite: MapMetadataShape = sanitizePlacements({ ...newMetadata, version: newVersion });
    let query = admin
        .from('assets')
        .update({ metadata: { map: toWrite, tags: ['map'] } })
        .eq('id', assetId);
    // Only filter on version when it was non-null in DB. Legacy maps bootstrap
    // on their first write — every subsequent write CASes normally.
    if (newMetadata.version !== undefined) {
        query = query.eq('metadata->map->>version', String(expectedVersion));
    }
    const { data, error } = await query.select('id');
    if (error) throw new Error(`Failed to save map: ${error.message}`);
    if (!data || data.length === 0) {
        throw new Error(
            `Map ${assetId} was modified by another writer (expected v${expectedVersion}). ` +
            `Call read_map again to get the latest version before retrying.`,
        );
    }
    return newVersion;
}

/** Upload a generated sub-asset (tile / object sprite) to storage + project_files. */
async function uploadSubAsset(
    ctx: ToolContext,
    relativePath: string,
    buffer: Buffer,
): Promise<string> {
    const admin = getAdmin();
    const storageKey = `projects/${ctx.userId}/${ctx.projectId}/${relativePath}`;
    const { error: upErr } = await admin.storage
        .from('assets')
        .upload(storageKey, buffer, { contentType: 'image/png', upsert: true });
    if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);
    await admin.from('project_files').upsert({
        project_id: ctx.projectId,
        path: relativePath,
        content_type: 'binary',
        size_bytes: buffer.byteLength,
        storage_key: storageKey,
    }, { onConflict: 'project_id,path' });
    return storageKey;
}

async function downloadBuffer(storageKey: string): Promise<Buffer> {
    const admin = getAdmin();
    const { data, error } = await admin.storage.from('assets').download(storageKey);
    if (error || !data) throw new Error(`Download failed for ${storageKey}: ${error?.message}`);
    const ab = await data.arrayBuffer();
    return Buffer.from(ab);
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'tile';
}

/** Clamp a rectangular region to the map's grid. Returns null if fully outside. */
function clampRegion(
    region: { x: number; y: number; w: number; h: number },
    gridW: number,
    gridH: number,
    // Corners grid is (gridW+1) × (gridH+1); cell grid is gridW × gridH.
    isCornerGrid: boolean,
): { x0: number; y0: number; x1: number; y1: number } | null {
    const maxX = isCornerGrid ? gridW : gridW - 1;
    const maxY = isCornerGrid ? gridH : gridH - 1;
    const x0 = Math.max(0, Math.floor(region.x));
    const y0 = Math.max(0, Math.floor(region.y));
    const x1 = Math.min(maxX, Math.floor(region.x + region.w - 1));
    const y1 = Math.min(maxY, Math.floor(region.y + region.h - 1));
    if (x0 > x1 || y0 > y1) return null;
    return { x0, y0, x1, y1 };
}

/** Resolve a layer_id to a concrete layer, falling back to the terrain layer.
 *  If the requested id doesn't exist, returns { error }. */
function resolveLayerId(
    meta: MapMetadataShape,
    layerId: string | undefined,
): { layerId: string } | { error: string } {
    const layers = meta.layers ?? [];
    const terrain = layers.find(l => l.kind === 'terrain');
    if (!layerId) {
        if (!terrain) return { error: 'Map has no terrain layer — metadata is in a bad state.' };
        return { layerId: terrain.id };
    }
    const found = layers.find(l => l.id === layerId);
    if (!found) {
        const available = layers.map(l => `${l.id} (${l.name}, ${l.kind})`).join(', ');
        return { error: `Layer "${layerId}" not found. Available: ${available || '(none)'}` };
    }
    if (found.locked) {
        return { error: `Layer "${found.name}" (${found.id}) is locked. Unlock it via set_layer_locked first.` };
    }
    return { layerId: found.id };
}

const start = () => Date.now();
const ok = (startedAt: number, output: unknown): ToolResult => ({
    callId: '', success: true, output, filesModified: [],
    duration_ms: Date.now() - startedAt,
});
const fail = (startedAt: number, error: string): ToolResult => ({
    callId: '', success: false, output: null, filesModified: [],
    error, duration_ms: Date.now() - startedAt,
});

// ── list_maps ─────────────────────────────────────────────────────────

registerTool({
    name: 'list_maps',
    description: 'List all maps in the current project with basic metadata (id, name, projection, grid size, tile size). Use this to find a map to read or edit.',
    access: ['build', 'explore'],
    isReadOnly: true,
    isConcurrencySafe: true,
    parameters: {
        type: 'object',
        properties: {},
    },
    execute: async (ctx): Promise<ToolResult> => {
        const s = start();
        const admin = getAdmin();
        const { data: rows, error } = await admin
            .from('assets')
            .select('id, name, storage_key, width, height, metadata, created_at')
            .eq('project_id', ctx.projectId)
            .eq('asset_type', 'map')
            .order('created_at', { ascending: false });
        if (error) return fail(s, `DB error: ${error.message}`);
        const maps = (rows ?? []).map(r => {
            const meta = (r.metadata as { map?: Partial<MapMetadataShape> } | null)?.map;
            return {
                asset_id: r.id,
                name: r.name,
                projection: meta?.projection ?? 'unknown',
                grid_w: meta?.grid_w ?? null,
                grid_h: meta?.grid_h ?? null,
                tile_size: meta?.tile_size ?? null,
                version: meta?.version ?? 0,
                storage_key: r.storage_key,
                width: r.width,
                height: r.height,
                created_at: r.created_at,
            };
        });
        return ok(s, { count: maps.length, maps });
    },
});

// ── read_map ──────────────────────────────────────────────────────────

registerTool({
    name: 'read_map',
    description: 'Fetch the full metadata for a specific map by asset_id, including terrain grids, tile libraries, and placements. Call this before editing so you see the current state and version.',
    access: ['build', 'explore'],
    isReadOnly: true,
    isConcurrencySafe: true,
    parameters: {
        type: 'object',
        properties: {
            asset_id: { type: 'string', description: 'The map asset id (UUID).' },
        },
        required: ['asset_id'],
    },
    execute: async (ctx, input): Promise<ToolResult> => {
        const s = start();
        try {
            const m = await loadMap(input.asset_id as string, ctx.projectId);
            // Basic analysis surfaces to save the agent a read-through of the raw metadata.
            const analysis = analyzeMetadata(m.metadata);
            return ok(s, {
                asset_id: m.assetId,
                name: m.name,
                storage_key: m.storageKey,
                version: m.version,
                metadata: m.metadata,
                analysis,
            });
        } catch (err) {
            return fail(s, err instanceof Error ? err.message : 'read_map failed');
        }
    },
});

function analyzeMetadata(meta: MapMetadataShape): Record<string, unknown> {
    const base: Record<string, unknown> = {
        projection: meta.projection,
        grid_w: meta.grid_w,
        grid_h: meta.grid_h,
        tile_size: meta.tile_size,
        object_library_size: meta.objects_library.length,
        placement_count: meta.placements.length,
    };
    if (meta.projection === 'orthogonal') {
        const corners = meta.corners ?? [];
        const counts: Record<TerrainCorner, number> = { lower: 0, upper: 0, transition: 0 };
        for (const row of corners) for (const c of row) counts[c] = (counts[c] ?? 0) + 1;
        base.wang_tile_count = meta.wang_tiles?.length ?? 0;
        base.corner_distribution = counts;
    } else {
        const stack = meta.iso_stack ?? [];
        let filled = 0, totalLevels = 0, maxStack = 0;
        for (const row of stack) for (const cell of row) {
            if (cell.length > 0) filled++;
            totalLevels += cell.length;
            if (cell.length > maxStack) maxStack = cell.length;
        }
        base.iso_tile_library_size = meta.iso_tiles?.length ?? 0;
        base.filled_cells = filled;
        base.empty_cells = meta.grid_w * meta.grid_h - filled;
        base.total_stacked_tiles = totalLevels;
        base.max_stack_depth = maxStack;
    }
    return base;
}

// ── paint_terrain_region (orthogonal) ─────────────────────────────────

registerTool({
    name: 'paint_terrain_region',
    description: 'Orthogonal maps only. Paint a rectangular region of terrain corners with one label (lower, upper, or transition). Coordinates are corner coords: a grid of size grid_w × grid_h has (grid_w + 1) × (grid_h + 1) corners. Example: to paint the top-left 4×4 cells as "upper", pass {x:0, y:0, w:5, h:5, label:"upper"} (5 corners span 4 cells).',
    access: ['build'],
    isReadOnly: false,
    parameters: {
        type: 'object',
        properties: {
            asset_id: { type: 'string', description: 'Map asset id.' },
            x: { type: 'integer', description: 'Left corner X (0-indexed).' },
            y: { type: 'integer', description: 'Top corner Y (0-indexed).' },
            w: { type: 'integer', description: 'Region width in corners (≥ 1).' },
            h: { type: 'integer', description: 'Region height in corners (≥ 1).' },
            label: { type: 'string', enum: ['lower', 'upper', 'transition'] },
        },
        required: ['asset_id', 'x', 'y', 'w', 'h', 'label'],
    },
    execute: async (ctx, input): Promise<ToolResult> => {
        const s = start();
        try {
            const m = await loadMap(input.asset_id as string, ctx.projectId);
            if (m.metadata.projection !== 'orthogonal') {
                return fail(s, `paint_terrain_region only works on orthogonal maps (got ${m.metadata.projection}). Use edit_iso_cells for isometric maps.`);
            }
            const region = clampRegion(
                { x: input.x as number, y: input.y as number, w: input.w as number, h: input.h as number },
                m.metadata.grid_w,
                m.metadata.grid_h,
                true,
            );
            if (!region) return fail(s, 'Region is entirely outside the corner grid.');

            const label = input.label as TerrainCorner;
            const corners = (m.metadata.corners ?? []).map(row => row.slice());
            // Ensure row shape matches (grid_h+1) × (grid_w+1).
            while (corners.length < m.metadata.grid_h + 1) corners.push([]);
            for (const row of corners) {
                while (row.length < m.metadata.grid_w + 1) row.push('lower');
            }
            let painted = 0;
            for (let y = region.y0; y <= region.y1; y++) {
                for (let x = region.x0; x <= region.x1; x++) {
                    if (corners[y][x] !== label) {
                        corners[y][x] = label;
                        painted++;
                    }
                }
            }
            const updated: MapMetadataShape = { ...m.metadata, corners };
            const newVersion = await saveMapMetadata(m.assetId, m.version, updated);
            return ok(s, {
                asset_id: m.assetId,
                corners_painted: painted,
                region: { x0: region.x0, y0: region.y0, x1: region.x1, y1: region.y1 },
                new_version: newVersion,
                note: painted === 0
                    ? 'No corners changed (region already had this label).'
                    : 'Corners updated in metadata. Call recompose_map to re-render the PNG.',
            });
        } catch (err) {
            return fail(s, err instanceof Error ? err.message : 'paint_terrain_region failed');
        }
    },
});

// ── edit_iso_cells (isometric) ────────────────────────────────────────

registerTool({
    name: 'edit_iso_cells',
    description: 'Isometric maps only. Modify a rectangular region of iso cells. Modes: "replace" sets the base tile (index 0), "stack_add" pushes a tile on top, "stack_pop" removes the top tile, "clear" empties the entire stack. For replace/stack_add you must provide a tile_id that exists in the map\'s iso_tiles library (see read_map).',
    access: ['build'],
    isReadOnly: false,
    parameters: {
        type: 'object',
        properties: {
            asset_id: { type: 'string' },
            x: { type: 'integer', description: 'Left cell X.' },
            y: { type: 'integer', description: 'Top cell Y.' },
            w: { type: 'integer', description: 'Region width in cells (≥ 1).' },
            h: { type: 'integer', description: 'Region height in cells (≥ 1).' },
            mode: { type: 'string', enum: ['replace', 'stack_add', 'stack_pop', 'clear'] },
            tile_id: { type: 'string', description: 'Required for replace/stack_add — must be in the map\'s iso_tiles library.' },
        },
        required: ['asset_id', 'x', 'y', 'w', 'h', 'mode'],
    },
    execute: async (ctx, input): Promise<ToolResult> => {
        const s = start();
        try {
            const m = await loadMap(input.asset_id as string, ctx.projectId);
            if (m.metadata.projection !== 'isometric') {
                return fail(s, `edit_iso_cells only works on isometric maps (got ${m.metadata.projection}).`);
            }
            const mode = input.mode as 'replace' | 'stack_add' | 'stack_pop' | 'clear';
            const tileId = input.tile_id as string | undefined;
            if ((mode === 'replace' || mode === 'stack_add') && !tileId) {
                return fail(s, `Mode "${mode}" requires a tile_id.`);
            }
            if (tileId) {
                const exists = (m.metadata.iso_tiles ?? []).some(t => t.id === tileId);
                if (!exists) {
                    const available = (m.metadata.iso_tiles ?? []).map(t => `${t.id} (${t.name})`).join(', ');
                    return fail(s, `tile_id "${tileId}" is not in the iso_tiles library. Available: ${available || '(none)'}`);
                }
            }
            const region = clampRegion(
                { x: input.x as number, y: input.y as number, w: input.w as number, h: input.h as number },
                m.metadata.grid_w,
                m.metadata.grid_h,
                false,
            );
            if (!region) return fail(s, 'Region is entirely outside the cell grid.');

            // Deep-clone the stack.
            const origStack = m.metadata.iso_stack ?? Array.from(
                { length: m.metadata.grid_h },
                () => Array.from({ length: m.metadata.grid_w }, () => [] as string[]),
            );
            const stack: string[][][] = origStack.map(row => row.map(cell => cell.slice()));
            let changed = 0;
            for (let y = region.y0; y <= region.y1; y++) {
                for (let x = region.x0; x <= region.x1; x++) {
                    const cell = stack[y][x] ?? [];
                    if (mode === 'replace') {
                        if (cell[0] === tileId) continue;
                        stack[y][x] = cell.length === 0 ? [tileId!] : [tileId!, ...cell.slice(1)];
                        changed++;
                    } else if (mode === 'stack_add') {
                        stack[y][x] = [...cell, tileId!];
                        changed++;
                    } else if (mode === 'stack_pop') {
                        if (cell.length === 0) continue;
                        stack[y][x] = cell.slice(0, -1);
                        changed++;
                    } else if (mode === 'clear') {
                        if (cell.length === 0) continue;
                        stack[y][x] = [];
                        changed++;
                    }
                }
            }
            const updated: MapMetadataShape = { ...m.metadata, iso_stack: stack };
            const newVersion = await saveMapMetadata(m.assetId, m.version, updated);
            return ok(s, {
                asset_id: m.assetId,
                cells_changed: changed,
                region: { x0: region.x0, y0: region.y0, x1: region.x1, y1: region.y1 },
                new_version: newVersion,
                note: changed === 0
                    ? 'No cells changed (already in target state).'
                    : 'Iso stack updated. Call recompose_map to re-render the PNG.',
            });
        } catch (err) {
            return fail(s, err instanceof Error ? err.message : 'edit_iso_cells failed');
        }
    },
});

// ── place_objects_on_map ──────────────────────────────────────────────

registerTool({
    name: 'place_objects_on_map',
    description: 'Add one or more object placements to a map. Each placement references either an object_id (from the map\'s objects_library) or an asset_id (a project sprite/sheet/animation). Coordinates are cell coords in [0, grid_w-1] × [0, grid_h-1]. For isometric maps, z_level defaults to the top of the cell\'s current stack. Pass layer_id to put the placements on a specific layer; defaults to the terrain layer.',
    access: ['build'],
    isReadOnly: false,
    parameters: {
        type: 'object',
        properties: {
            asset_id: { type: 'string', description: 'The map asset id.' },
            layer_id: { type: 'string', description: 'Optional. Default layer for all placements below that don\'t set their own. Defaults to the terrain layer if omitted.' },
            placements: {
                type: 'array',
                description: 'Placements to add.',
                items: {
                    type: 'object',
                    properties: {
                        object_id: { type: 'string', description: 'A library object id from map.objects_library. Mutually exclusive with asset_id.' },
                        source_asset_id: { type: 'string', description: 'A project asset id (sprite/sheet/animation). Mutually exclusive with object_id.' },
                        grid_x: { type: 'integer' },
                        grid_y: { type: 'integer' },
                        z_level: { type: 'integer', description: 'Isometric only. Default: top of cell stack.' },
                        layer_id: { type: 'string', description: 'Optional per-placement override. Takes precedence over the top-level layer_id.' },
                    },
                    required: ['grid_x', 'grid_y'],
                },
            },
        },
        required: ['asset_id', 'placements'],
    },
    execute: async (ctx, input): Promise<ToolResult> => {
        const s = start();
        try {
            const m = await loadMap(input.asset_id as string, ctx.projectId);
            const raw = input.placements as Array<{
                object_id?: string;
                source_asset_id?: string;
                grid_x: number;
                grid_y: number;
                z_level?: number;
                layer_id?: string;
            }>;
            if (!Array.isArray(raw) || raw.length === 0) {
                return fail(s, 'placements must be a non-empty array.');
            }

            const defaultLayerId = input.layer_id as string | undefined;
            const defaultResolved = resolveLayerId(m.metadata, defaultLayerId);
            if ('error' in defaultResolved) return fail(s, defaultResolved.error);

            const libraryIds = new Set((m.metadata.objects_library ?? []).map(o => o.id));
            const additions: MapObjectPlacement[] = [];
            const skipped: Array<{ reason: string; index: number }> = [];
            for (let i = 0; i < raw.length; i++) {
                const p = raw[i];
                if (!!p.object_id === !!p.source_asset_id) {
                    skipped.push({ reason: 'must set exactly one of object_id or source_asset_id', index: i });
                    continue;
                }
                if (p.grid_x < 0 || p.grid_y < 0 || p.grid_x >= m.metadata.grid_w || p.grid_y >= m.metadata.grid_h) {
                    skipped.push({ reason: `out of grid bounds (grid is ${m.metadata.grid_w}×${m.metadata.grid_h})`, index: i });
                    continue;
                }
                if (p.object_id && !libraryIds.has(p.object_id)) {
                    skipped.push({ reason: `object_id "${p.object_id}" not in objects_library`, index: i });
                    continue;
                }
                const perPlacement = p.layer_id
                    ? resolveLayerId(m.metadata, p.layer_id)
                    : defaultResolved;
                if ('error' in perPlacement) {
                    skipped.push({ reason: perPlacement.error, index: i });
                    continue;
                }
                let z = p.z_level;
                if (m.metadata.projection === 'isometric' && z === undefined) {
                    z = m.metadata.iso_stack?.[p.grid_y]?.[p.grid_x]?.length ?? 0;
                }
                additions.push({
                    id: crypto.randomUUID(),
                    object_id: p.object_id,
                    asset_id: p.source_asset_id,
                    grid_x: p.grid_x,
                    grid_y: p.grid_y,
                    z_level: z,
                    layer_id: perPlacement.layerId,
                });
            }
            if (additions.length === 0) {
                return fail(s, `No valid placements. Skipped: ${JSON.stringify(skipped)}`);
            }
            const updated: MapMetadataShape = {
                ...m.metadata,
                placements: [...m.metadata.placements, ...additions],
            };
            const newVersion = await saveMapMetadata(m.assetId, m.version, updated);
            return ok(s, {
                asset_id: m.assetId,
                added: additions.length,
                placement_ids: additions.map(a => a.id),
                skipped,
                new_version: newVersion,
                note: 'Placements added. Call recompose_map to re-render the PNG.',
            });
        } catch (err) {
            return fail(s, err instanceof Error ? err.message : 'place_objects_on_map failed');
        }
    },
});

// ── remove_placements_from_map ────────────────────────────────────────

registerTool({
    name: 'remove_placements_from_map',
    description: 'Remove placements from a map. Pass placement_ids for specific placements, a bounding box region (x,y,w,h), and/or layer_id to restrict the scope. If region+layer_id are both set, only placements matching BOTH are removed; placement_ids are always removed regardless of layer.',
    access: ['build'],
    isReadOnly: false,
    isDestructive: true,
    parameters: {
        type: 'object',
        properties: {
            asset_id: { type: 'string' },
            placement_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional list of placement ids to remove.',
            },
            region: {
                type: 'object',
                description: 'Optional bounding box in cell coords.',
                properties: {
                    x: { type: 'integer' }, y: { type: 'integer' },
                    w: { type: 'integer' }, h: { type: 'integer' },
                },
                required: ['x', 'y', 'w', 'h'],
            },
            layer_id: {
                type: 'string',
                description: 'Optional. If set, only placements on this layer are eligible for region-based removal.',
            },
        },
        required: ['asset_id'],
    },
    execute: async (ctx, input): Promise<ToolResult> => {
        const s = start();
        try {
            const m = await loadMap(input.asset_id as string, ctx.projectId);
            const ids = new Set((input.placement_ids as string[] | undefined) ?? []);
            const region = input.region as { x: number; y: number; w: number; h: number } | undefined;
            const layerId = input.layer_id as string | undefined;
            if (ids.size === 0 && !region && !layerId) {
                return fail(s, 'Pass at least one of placement_ids, region, or layer_id.');
            }
            if (layerId && !(m.metadata.layers ?? []).some(l => l.id === layerId)) {
                return fail(s, `Layer "${layerId}" not found.`);
            }
            const clamped = region ? clampRegion(region, m.metadata.grid_w, m.metadata.grid_h, false) : null;
            const before = m.metadata.placements.length;
            const filtered = m.metadata.placements.filter(p => {
                if (ids.has(p.id)) return false;
                const layerMatch = !layerId || p.layer_id === layerId;
                if (clamped
                    && layerMatch
                    && p.grid_x >= clamped.x0 && p.grid_x <= clamped.x1
                    && p.grid_y >= clamped.y0 && p.grid_y <= clamped.y1) return false;
                // Layer-only sweep (no region): remove every placement on that layer.
                if (!region && layerId && p.layer_id === layerId) return false;
                return true;
            });
            const removed = before - filtered.length;
            if (removed === 0) {
                return ok(s, {
                    asset_id: m.assetId, removed: 0, new_version: m.version,
                    note: 'No placements matched.',
                });
            }
            const updated: MapMetadataShape = { ...m.metadata, placements: filtered };
            const newVersion = await saveMapMetadata(m.assetId, m.version, updated);
            return ok(s, {
                asset_id: m.assetId,
                removed,
                new_version: newVersion,
                note: 'Placements removed. Call recompose_map to re-render the PNG.',
            });
        } catch (err) {
            return fail(s, err instanceof Error ? err.message : 'remove_placements_from_map failed');
        }
    },
});

// ── extend_map_grid ───────────────────────────────────────────────────

registerTool({
    name: 'extend_map_grid',
    description: `Grow or shrink the map grid. Positive add_cols/add_rows extend; negative shrink. Minimum 1×1, maximum ${MAX_GRID_DIMENSION}×${MAX_GRID_DIMENSION}. Corners/iso_stack are preserved for overlapping cells; new cells are filled with "lower" (orthogonal) or empty stacks (isometric). Shrinking drops placements that fall outside.`,
    access: ['build'],
    isReadOnly: false,
    parameters: {
        type: 'object',
        properties: {
            asset_id: { type: 'string' },
            add_cols: { type: 'integer', description: 'Columns to add (negative to remove).' },
            add_rows: { type: 'integer', description: 'Rows to add (negative to remove).' },
        },
        required: ['asset_id', 'add_cols', 'add_rows'],
    },
    execute: async (ctx, input): Promise<ToolResult> => {
        const s = start();
        try {
            const m = await loadMap(input.asset_id as string, ctx.projectId);
            const addC = input.add_cols as number;
            const addR = input.add_rows as number;
            const newW = Math.max(1, Math.min(MAX_GRID_DIMENSION, m.metadata.grid_w + addC));
            const newH = Math.max(1, Math.min(MAX_GRID_DIMENSION, m.metadata.grid_h + addR));
            if (newW === m.metadata.grid_w && newH === m.metadata.grid_h) {
                return ok(s, {
                    asset_id: m.assetId, new_version: m.version,
                    note: 'Grid dimensions unchanged (likely hit min/max clamp).',
                });
            }

            const patch: Partial<MapMetadataShape> = { grid_w: newW, grid_h: newH };
            if (m.metadata.projection === 'isometric') {
                const old = m.metadata.iso_stack ?? [];
                const stack: string[][][] = [];
                for (let y = 0; y < newH; y++) {
                    const row: string[][] = [];
                    for (let x = 0; x < newW; x++) row.push((old[y]?.[x] ?? []).slice());
                    stack.push(row);
                }
                patch.iso_stack = stack;
            } else {
                const old = m.metadata.corners ?? [];
                const corners: TerrainCorner[][] = [];
                for (let y = 0; y <= newH; y++) {
                    const row: TerrainCorner[] = [];
                    for (let x = 0; x <= newW; x++) row.push(old[y]?.[x] ?? 'lower');
                    corners.push(row);
                }
                patch.corners = corners;
            }
            // Drop placements now OOB (saveMapMetadata's sanitizer also does this,
            // but doing it here keeps the response counts accurate).
            const before = m.metadata.placements.length;
            const kept = m.metadata.placements.filter(p =>
                p.grid_x >= 0 && p.grid_y >= 0 && p.grid_x < newW && p.grid_y < newH,
            );
            patch.placements = kept;

            const updated: MapMetadataShape = { ...m.metadata, ...patch };
            const newVersion = await saveMapMetadata(m.assetId, m.version, updated);
            return ok(s, {
                asset_id: m.assetId,
                old_grid: { w: m.metadata.grid_w, h: m.metadata.grid_h },
                new_grid: { w: newW, h: newH },
                placements_dropped: before - kept.length,
                new_version: newVersion,
                note: 'Grid resized. Call recompose_map to re-render the PNG.',
            });
        } catch (err) {
            return fail(s, err instanceof Error ? err.message : 'extend_map_grid failed');
        }
    },
});

// ── add_iso_tile_to_map ───────────────────────────────────────────────

registerTool({
    name: 'add_iso_tile_to_map',
    description: 'Generate a new isometric tile variant via PixelLab and add it to an isometric map\'s iso_tiles library. Optionally paint it onto a region in the same call. Returns the new tile_id so subsequent edit_iso_cells calls can reference it.',
    access: ['build'],
    isReadOnly: false,
    parameters: {
        type: 'object',
        properties: {
            asset_id: { type: 'string', description: 'The map asset id.' },
            prompt: { type: 'string', description: 'Description of the new tile, e.g. "mossy stone block".' },
            shape: { type: 'string', enum: ['thin tile', 'thick tile', 'block'], default: 'block' },
            paint_region: {
                type: 'object',
                description: 'Optional. If present, also replace the base tile in this region with the new tile.',
                properties: {
                    x: { type: 'integer' }, y: { type: 'integer' },
                    w: { type: 'integer' }, h: { type: 'integer' },
                },
                required: ['x', 'y', 'w', 'h'],
            },
        },
        required: ['asset_id', 'prompt'],
    },
    execute: async (ctx, input): Promise<ToolResult> => {
        const s = start();
        try {
            const m = await loadMap(input.asset_id as string, ctx.projectId);
            if (m.metadata.projection !== 'isometric') {
                return fail(s, `add_iso_tile_to_map only works on isometric maps.`);
            }
            // PixelLab constraint: 16 or 32 px only.
            const ts = m.metadata.tile_size === 16 ? 16 : 32;
            const result = await generateSingleIsoTile({
                prompt: input.prompt as string,
                tileSize: ts,
                shape: (input.shape as 'thin tile' | 'thick tile' | 'block' | undefined) ?? 'block',
            });
            if (!result.success || !result.buffer) {
                return fail(s, result.error || 'Iso tile generation failed');
            }
            const tileId = `iso_${crypto.randomUUID().slice(0, 8)}`;
            const path = `assets/maps/${m.assetId}/iso/${tileId}_${slugify(input.prompt as string)}.png`;
            const sk = await uploadSubAsset(ctx, path, result.buffer);
            const newTile: MapIsoTile = {
                id: tileId,
                storage_key: sk,
                name: (input.prompt as string).slice(0, 30),
                width: result.width,
                height: result.height,
            };

            // Build the updated metadata (+ optional paint in the same transaction).
            let updated: MapMetadataShape = {
                ...m.metadata,
                iso_tiles: [...(m.metadata.iso_tiles ?? []), newTile],
            };
            let painted = 0;
            const paintRegion = input.paint_region as { x: number; y: number; w: number; h: number } | undefined;
            if (paintRegion) {
                const region = clampRegion(paintRegion, m.metadata.grid_w, m.metadata.grid_h, false);
                if (region) {
                    const origStack = updated.iso_stack ?? Array.from(
                        { length: m.metadata.grid_h },
                        () => Array.from({ length: m.metadata.grid_w }, () => [] as string[]),
                    );
                    const stack = origStack.map(row => row.map(cell => cell.slice()));
                    for (let y = region.y0; y <= region.y1; y++) {
                        for (let x = region.x0; x <= region.x1; x++) {
                            const cell = stack[y][x] ?? [];
                            stack[y][x] = cell.length === 0 ? [tileId] : [tileId, ...cell.slice(1)];
                            painted++;
                        }
                    }
                    updated = { ...updated, iso_stack: stack };
                }
            }
            const newVersion = await saveMapMetadata(m.assetId, m.version, updated);
            return ok(s, {
                asset_id: m.assetId,
                tile_id: tileId,
                storage_key: sk,
                cells_painted: painted,
                cost: result.cost,
                new_version: newVersion,
                note: 'Iso tile added' + (painted ? ` and painted into ${painted} cells` : '') + '. Call recompose_map to re-render.',
            });
        } catch (err) {
            return fail(s, err instanceof Error ? err.message : 'add_iso_tile_to_map failed');
        }
    },
});

// ── add_object_to_map ─────────────────────────────────────────────────

registerTool({
    name: 'add_object_to_map',
    description: 'Generate a new object sprite (tree, rock, chest, etc.) via PixelLab and add it to a map\'s objects_library. Optionally place it at one or more grid coords in the same call. Returns the new object_id for later placements.',
    access: ['build'],
    isReadOnly: false,
    parameters: {
        type: 'object',
        properties: {
            asset_id: { type: 'string' },
            prompt: { type: 'string' },
            width_tiles: { type: 'integer', default: 1, description: 'How many tiles wide (1-4).' },
            height_tiles: { type: 'integer', default: 1 },
            view: { type: 'string', enum: ['low top-down', 'high top-down', 'side'], default: 'high top-down' },
            place_at: {
                type: 'array',
                description: 'Optional. Cell coords where the new object should be placed immediately.',
                items: {
                    type: 'object',
                    properties: { grid_x: { type: 'integer' }, grid_y: { type: 'integer' } },
                    required: ['grid_x', 'grid_y'],
                },
            },
            layer_id: { type: 'string', description: 'Optional. Layer to attach the new placements to. Defaults to the terrain layer.' },
        },
        required: ['asset_id', 'prompt'],
    },
    execute: async (ctx, input): Promise<ToolResult> => {
        const s = start();
        try {
            const m = await loadMap(input.asset_id as string, ctx.projectId);
            const resolved = resolveLayerId(m.metadata, input.layer_id as string | undefined);
            if ('error' in resolved) return fail(s, resolved.error);
            // Style-match: use the current composed map PNG as background for inpainting.
            let backgroundImageBase64: string | undefined;
            if (m.storageKey) {
                try {
                    const bg = await downloadBuffer(m.storageKey);
                    backgroundImageBase64 = bg.toString('base64');
                } catch {
                    // Style-match is optional; fall back to plain generation.
                }
            }
            const result = await generateMapObjectV2({
                prompt: input.prompt as string,
                tileSize: m.metadata.tile_size,
                widthTiles: (input.width_tiles as number | undefined) ?? 1,
                heightTiles: (input.height_tiles as number | undefined) ?? 1,
                view: (input.view as 'low top-down' | 'high top-down' | 'side' | undefined) ?? 'high top-down',
                backgroundImageBase64,
            });
            if (!result.success || !result.buffer) {
                return fail(s, result.error || 'Object generation failed');
            }
            const objectId = `obj_${crypto.randomUUID().slice(0, 8)}`;
            const path = `assets/maps/${m.assetId}/objects/${objectId}_${slugify(input.prompt as string)}.png`;
            const sk = await uploadSubAsset(ctx, path, result.buffer);
            const entry: MapObjectEntry = {
                id: objectId,
                storage_key: sk,
                name: (input.prompt as string).slice(0, 30),
                width: result.width,
                height: result.height,
                prompt: input.prompt as string,
            };

            // Optional immediate placements.
            const placeAt = input.place_at as Array<{ grid_x: number; grid_y: number }> | undefined;
            const additions: MapObjectPlacement[] = [];
            const skipped: Array<{ reason: string; index: number }> = [];
            for (let i = 0; i < (placeAt?.length ?? 0); i++) {
                const p = placeAt![i];
                if (p.grid_x < 0 || p.grid_y < 0 || p.grid_x >= m.metadata.grid_w || p.grid_y >= m.metadata.grid_h) {
                    skipped.push({ reason: 'out of grid bounds', index: i });
                    continue;
                }
                let z: number | undefined;
                if (m.metadata.projection === 'isometric') {
                    z = m.metadata.iso_stack?.[p.grid_y]?.[p.grid_x]?.length ?? 0;
                }
                additions.push({
                    id: crypto.randomUUID(),
                    object_id: objectId,
                    grid_x: p.grid_x,
                    grid_y: p.grid_y,
                    z_level: z,
                    layer_id: resolved.layerId,
                });
            }

            const updated: MapMetadataShape = {
                ...m.metadata,
                objects_library: [...m.metadata.objects_library, entry],
                placements: [...m.metadata.placements, ...additions],
            };
            const newVersion = await saveMapMetadata(m.assetId, m.version, updated);
            return ok(s, {
                asset_id: m.assetId,
                object_id: objectId,
                storage_key: sk,
                placements_added: additions.length,
                placement_ids: additions.map(a => a.id),
                skipped,
                cost: result.cost,
                new_version: newVersion,
                note: 'Object added to library' + (additions.length ? ` and placed ${additions.length} times` : '') + '. Call recompose_map to re-render.',
            });
        } catch (err) {
            return fail(s, err instanceof Error ? err.message : 'add_object_to_map failed');
        }
    },
});

// ── recompose_map ─────────────────────────────────────────────────────

registerTool({
    name: 'recompose_map',
    description: 'Re-render the composed PNG for a map after edits and persist it to storage. Expensive (~10-30s): downloads all tile and object buffers and re-runs the compositor. Call this ONCE at the end of an editing session, not after every tiny change.',
    access: ['build'],
    isReadOnly: false,
    parameters: {
        type: 'object',
        properties: {
            asset_id: { type: 'string' },
        },
        required: ['asset_id'],
    },
    execute: async (ctx, input): Promise<ToolResult> => {
        const s = start();
        try {
            const m = await loadMap(input.asset_id as string, ctx.projectId);
            const meta = m.metadata;

            // Resolve all placement buffers (library objects + project assets).
            const objectBufferMap = new Map<string, { buffer: Buffer; w: number; h: number }>();
            for (const o of meta.objects_library) {
                try {
                    const buf = await downloadBuffer(o.storage_key);
                    objectBufferMap.set(o.id, { buffer: buf, w: o.width, h: o.height });
                } catch {
                    // Skip missing.
                }
            }
            const assetBufferMap = new Map<string, { buffer: Buffer; w: number; h: number }>();
            const placementAssetIds = Array.from(new Set(
                meta.placements.map(p => p.asset_id).filter((id): id is string => typeof id === 'string'),
            ));
            if (placementAssetIds.length > 0) {
                const admin = getAdmin();
                const { data: rows } = await admin
                    .from('assets')
                    .select('id, storage_key, width, height, metadata')
                    .in('id', placementAssetIds);
                for (const row of rows ?? []) {
                    try {
                        const buf = await downloadBuffer(row.storage_key);
                        const frames = (row.metadata as { frames?: Array<{ x: number; y: number; width: number; height: number }> } | null)?.frames;
                        if (frames && frames.length > 0) {
                            const f0 = frames[0];
                            const sharp = (await import('sharp')).default;
                            const cropped = await sharp(buf)
                                .extract({ left: f0.x, top: f0.y, width: f0.width, height: f0.height })
                                .png()
                                .toBuffer();
                            assetBufferMap.set(row.id, { buffer: cropped, w: f0.width, h: f0.height });
                        } else {
                            assetBufferMap.set(row.id, {
                                buffer: buf,
                                w: row.width ?? meta.tile_size,
                                h: row.height ?? meta.tile_size,
                            });
                        }
                    } catch {
                        // Skip.
                    }
                }
            }
            // Layer-aware render ordering: filter invisible + collision, sort
            // by z_order, stamp per-layer opacity. Mirrors the logic in the
            // map-action route so both entry points stay in sync.
            const layers = meta.layers ?? [];
            const layerById = new Map(layers.map(l => [l.id, l]));
            const sortedLayers = [...layers].sort((a, b) => a.z_order - b.z_order);
            const renderableLayerIds = new Set(
                sortedLayers.filter(l => l.visible && l.kind !== 'collision').map(l => l.id),
            );
            const layerOrderIndex = new Map(sortedLayers.map((l, i) => [l.id, i]));
            const placements = meta.placements
                .filter(p => !p.layer_id || renderableLayerIds.has(p.layer_id))
                .sort((a, b) => {
                    const ai = layerOrderIndex.get(a.layer_id ?? '') ?? 0;
                    const bi = layerOrderIndex.get(b.layer_id ?? '') ?? 0;
                    return ai - bi;
                })
                .map(p => {
                    const buf = p.asset_id
                        ? assetBufferMap.get(p.asset_id)
                        : p.object_id ? objectBufferMap.get(p.object_id) : undefined;
                    if (!buf) return null;
                    const layer = p.layer_id ? layerById.get(p.layer_id) : undefined;
                    return {
                        buffer: buf.buffer,
                        gridX: p.grid_x,
                        gridY: p.grid_y,
                        width: buf.w,
                        height: buf.h,
                        zLevel: p.z_level,
                        opacity: layer?.opacity ?? 1,
                    };
                })
                .filter((x): x is NonNullable<typeof x> => x !== null);

            let composed: Buffer;
            let outW: number;
            let outH: number;

            if (meta.projection === 'isometric') {
                const tiles = meta.iso_tiles ?? [];
                const tileBufById = new Map<string, Buffer>();
                for (const t of tiles) {
                    try { tileBufById.set(t.id, await downloadBuffer(t.storage_key)); } catch { /* skip */ }
                }
                const stack = meta.iso_stack ?? (meta.iso_grid ?? []).map(row => row.map(id => (id ? [id] : [])));
                const tileStack: (Buffer | null)[][][] = stack.map(row =>
                    row.map(cell => cell.map(id => tileBufById.get(id) ?? null)),
                );
                const firstTile = tiles[0];
                const tileRenderWidth = firstTile?.width ?? meta.tile_size * 2;
                const tileRenderHeight = tiles.reduce((max, t) => Math.max(max, t.height), 0) || meta.tile_size * 2;

                composed = await composeIsoMap({
                    tileSize: meta.tile_size,
                    gridW: meta.grid_w,
                    gridH: meta.grid_h,
                    tileStack,
                    tileRenderWidth,
                    tileRenderHeight,
                    placements,
                });
                let maxDepth = 0;
                for (const row of stack) for (const cell of row) if (cell.length > maxDepth) maxDepth = cell.length;
                const stackStep = Math.max(meta.tile_size / 2, tileRenderHeight - meta.tile_size / 2);
                const stackHeadroom = Math.max(0, maxDepth - 1) * stackStep;
                const topOverhang = Math.max(0, tileRenderHeight - meta.tile_size / 2);
                outW = Math.ceil((meta.grid_w + meta.grid_h) * (meta.tile_size / 2) + tileRenderWidth);
                outH = Math.ceil(
                    (meta.grid_w + meta.grid_h) * (meta.tile_size / 4)
                    + meta.tile_size / 2 + topOverhang + stackHeadroom,
                );
            } else {
                const wangTiles = meta.wang_tiles ?? [];
                const wangLookup: Array<{ id: string; buffer: Buffer; corners: typeof wangTiles[number]['corners'] }> = [];
                for (const t of wangTiles) {
                    try { wangLookup.push({ id: t.id, buffer: await downloadBuffer(t.storage_key), corners: t.corners }); } catch { /* skip */ }
                }
                composed = await composeWangMap({
                    tileSize: meta.tile_size,
                    gridW: meta.grid_w,
                    gridH: meta.grid_h,
                    corners: meta.corners ?? [],
                    wangTiles: wangLookup,
                    placements,
                });
                outW = meta.grid_w * meta.tile_size;
                outH = meta.grid_h * meta.tile_size;
            }

            // Write the composed PNG + update the row (CAS on version).
            const path = `assets/maps/${m.assetId}.png`;
            const sk = await uploadSubAsset(ctx, path, composed);
            const newVersion = m.version + 1;
            const updatedMeta: MapMetadataShape = { ...meta, version: newVersion };
            const admin = getAdmin();
            let query = admin
                .from('assets')
                .update({
                    storage_key: sk,
                    width: outW,
                    height: outH,
                    metadata: { map: updatedMeta, tags: ['map'] },
                })
                .eq('id', m.assetId);
            if (meta.version !== undefined) {
                query = query.eq('metadata->map->>version', String(m.version));
            }
            const { data: rows, error: updErr } = await query.select('id');
            if (updErr) return fail(s, `DB update failed: ${updErr.message}`);
            if (!rows || rows.length === 0) {
                return fail(s, `Recompose lost a race with another writer. Call read_map again and retry.`);
            }

            return ok(s, {
                asset_id: m.assetId,
                storage_key: sk,
                width: outW,
                height: outH,
                new_version: newVersion,
                placement_count: placements.length,
                note: 'Map recomposed and persisted. Open in MapStudio to see the new render.',
            });
        } catch (err) {
            return fail(s, err instanceof Error ? err.message : 'recompose_map failed');
        }
    },
});

// ── list_layers ───────────────────────────────────────────────────────

registerTool({
    name: 'list_layers',
    description: 'List all layers on a map with their kind, visibility, lock, opacity, z-order, and placement count. Use before layer-targeted edits so the agent knows which layer_ids exist.',
    access: ['build', 'explore'],
    isReadOnly: true,
    isConcurrencySafe: true,
    parameters: {
        type: 'object',
        properties: {
            asset_id: { type: 'string' },
        },
        required: ['asset_id'],
    },
    execute: async (ctx, input): Promise<ToolResult> => {
        const s = start();
        try {
            const m = await loadMap(input.asset_id as string, ctx.projectId);
            const layers = m.metadata.layers ?? [];
            const counts = new Map<string, number>();
            for (const p of m.metadata.placements) {
                if (!p.layer_id) continue;
                counts.set(p.layer_id, (counts.get(p.layer_id) ?? 0) + 1);
            }
            const view = [...layers]
                .sort((a, b) => a.z_order - b.z_order)
                .map(l => ({ ...l, placement_count: counts.get(l.id) ?? 0 }));
            return ok(s, { asset_id: m.assetId, version: m.version, layers: view });
        } catch (err) {
            return fail(s, err instanceof Error ? err.message : 'list_layers failed');
        }
    },
});

// ── create_layer ──────────────────────────────────────────────────────

registerTool({
    name: 'create_layer',
    description: 'Create a new layer on a map. Non-terrain kinds only (decoration, collision, overlay) — terrain is auto-created. New layer goes on top of the draw stack (highest z_order).',
    access: ['build'],
    isReadOnly: false,
    parameters: {
        type: 'object',
        properties: {
            asset_id: { type: 'string' },
            name: { type: 'string', description: 'Human-readable layer name (e.g. "Trees", "Walls", "UI").' },
            kind: { type: 'string', enum: ['decoration', 'collision', 'overlay'] },
            visible: { type: 'boolean', default: true },
            opacity: { type: 'number', description: '0–1, default 1.' },
        },
        required: ['asset_id', 'name', 'kind'],
    },
    execute: async (ctx, input): Promise<ToolResult> => {
        const s = start();
        try {
            const m = await loadMap(input.asset_id as string, ctx.projectId);
            const kind = input.kind as LayerKind;
            if (kind === 'terrain') return fail(s, 'Cannot create a terrain layer — one is auto-managed per map.');
            const name = (input.name as string).trim();
            if (!name) return fail(s, 'name cannot be empty.');
            const opacity = Math.max(0, Math.min(1, (input.opacity as number | undefined) ?? 1));
            const visible = (input.visible as boolean | undefined) ?? true;
            const existing = m.metadata.layers ?? [];
            const maxZ = existing.reduce((max, l) => Math.max(max, l.z_order), -1);
            const newLayer: MapLayer = {
                id: `layer_${crypto.randomUUID().slice(0, 8)}`,
                name,
                kind,
                visible,
                locked: false,
                opacity,
                z_order: maxZ + 1,
            };
            const updated: MapMetadataShape = { ...m.metadata, layers: [...existing, newLayer] };
            const newVersion = await saveMapMetadata(m.assetId, m.version, updated);
            return ok(s, {
                asset_id: m.assetId,
                layer: newLayer,
                new_version: newVersion,
                note: 'Layer created. Reference this layer_id when placing objects.',
            });
        } catch (err) {
            return fail(s, err instanceof Error ? err.message : 'create_layer failed');
        }
    },
});

// ── delete_layer ──────────────────────────────────────────────────────

registerTool({
    name: 'delete_layer',
    description: 'Delete a layer. Its placements are NOT removed — they are reattached to the terrain layer. To fully drop the placements first, call remove_placements_from_map with layer_id.',
    access: ['build'],
    isReadOnly: false,
    isDestructive: true,
    parameters: {
        type: 'object',
        properties: {
            asset_id: { type: 'string' },
            layer_id: { type: 'string' },
        },
        required: ['asset_id', 'layer_id'],
    },
    execute: async (ctx, input): Promise<ToolResult> => {
        const s = start();
        try {
            const m = await loadMap(input.asset_id as string, ctx.projectId);
            const layerId = input.layer_id as string;
            const layers = m.metadata.layers ?? [];
            const target = layers.find(l => l.id === layerId);
            if (!target) return fail(s, `Layer "${layerId}" not found.`);
            if (target.kind === 'terrain') return fail(s, 'Cannot delete the terrain layer.');
            const terrain = layers.find(l => l.kind === 'terrain');
            if (!terrain) return fail(s, 'Map has no terrain layer — metadata corrupt.');

            const reattached = m.metadata.placements.map(p =>
                p.layer_id === layerId ? { ...p, layer_id: terrain.id } : p,
            );
            const moved = reattached.filter((p, i) => p !== m.metadata.placements[i]).length;
            const updated: MapMetadataShape = {
                ...m.metadata,
                layers: layers.filter(l => l.id !== layerId),
                placements: reattached,
            };
            const newVersion = await saveMapMetadata(m.assetId, m.version, updated);
            return ok(s, {
                asset_id: m.assetId,
                deleted_layer_id: layerId,
                placements_reattached: moved,
                new_version: newVersion,
                note: moved > 0
                    ? `Layer removed; ${moved} placements were moved to the terrain layer.`
                    : 'Layer removed. No placements were affected.',
            });
        } catch (err) {
            return fail(s, err instanceof Error ? err.message : 'delete_layer failed');
        }
    },
});

// ── update_layer ──────────────────────────────────────────────────────

registerTool({
    name: 'update_layer',
    description: 'Update a layer\'s properties. Set any subset of: name, visible, locked, opacity. For reordering (z_order) use move_layer.',
    access: ['build'],
    isReadOnly: false,
    parameters: {
        type: 'object',
        properties: {
            asset_id: { type: 'string' },
            layer_id: { type: 'string' },
            name: { type: 'string' },
            visible: { type: 'boolean' },
            locked: { type: 'boolean' },
            opacity: { type: 'number', description: '0–1' },
        },
        required: ['asset_id', 'layer_id'],
    },
    execute: async (ctx, input): Promise<ToolResult> => {
        const s = start();
        try {
            const m = await loadMap(input.asset_id as string, ctx.projectId);
            const layerId = input.layer_id as string;
            const layers = m.metadata.layers ?? [];
            const idx = layers.findIndex(l => l.id === layerId);
            if (idx < 0) return fail(s, `Layer "${layerId}" not found.`);
            const cur = layers[idx];
            const patch: Partial<MapLayer> = {};
            if (typeof input.name === 'string') {
                const n = (input.name as string).trim();
                if (!n) return fail(s, 'name cannot be empty.');
                patch.name = n;
            }
            if (typeof input.visible === 'boolean') patch.visible = input.visible as boolean;
            if (typeof input.locked === 'boolean') patch.locked = input.locked as boolean;
            if (typeof input.opacity === 'number') {
                patch.opacity = Math.max(0, Math.min(1, input.opacity as number));
            }
            if (Object.keys(patch).length === 0) {
                return ok(s, { asset_id: m.assetId, new_version: m.version, note: 'No fields set — nothing to update.' });
            }
            const nextLayers = layers.slice();
            nextLayers[idx] = { ...cur, ...patch };
            const updated: MapMetadataShape = { ...m.metadata, layers: nextLayers };
            const newVersion = await saveMapMetadata(m.assetId, m.version, updated);
            return ok(s, {
                asset_id: m.assetId,
                layer: nextLayers[idx],
                new_version: newVersion,
                note: 'Layer updated. Call recompose_map to re-render if visibility/opacity changed.',
            });
        } catch (err) {
            return fail(s, err instanceof Error ? err.message : 'update_layer failed');
        }
    },
});

// ── move_layer ────────────────────────────────────────────────────────

registerTool({
    name: 'move_layer',
    description: 'Reorder a layer in the draw stack. direction="up" draws on top, "down" draws below. The terrain layer cannot be moved above non-terrain layers — terrain always stays at the bottom.',
    access: ['build'],
    isReadOnly: false,
    parameters: {
        type: 'object',
        properties: {
            asset_id: { type: 'string' },
            layer_id: { type: 'string' },
            direction: { type: 'string', enum: ['up', 'down'] },
        },
        required: ['asset_id', 'layer_id', 'direction'],
    },
    execute: async (ctx, input): Promise<ToolResult> => {
        const s = start();
        try {
            const m = await loadMap(input.asset_id as string, ctx.projectId);
            const layerId = input.layer_id as string;
            const direction = input.direction as 'up' | 'down';
            const layers = m.metadata.layers ?? [];
            const sorted = [...layers].sort((a, b) => a.z_order - b.z_order);
            const idx = sorted.findIndex(l => l.id === layerId);
            if (idx < 0) return fail(s, `Layer "${layerId}" not found.`);

            const swapIdx = direction === 'up' ? idx + 1 : idx - 1;
            if (swapIdx < 0 || swapIdx >= sorted.length) {
                return ok(s, {
                    asset_id: m.assetId, new_version: m.version,
                    note: `Already at the ${direction === 'up' ? 'top' : 'bottom'} of the stack.`,
                });
            }
            // Terrain is pinned to the bottom. Don't let swaps cross it.
            if (sorted[idx].kind === 'terrain' || sorted[swapIdx].kind === 'terrain') {
                return fail(s, 'Terrain layer is locked at the bottom of the stack and cannot swap.');
            }
            [sorted[idx], sorted[swapIdx]] = [sorted[swapIdx], sorted[idx]];
            const repacked = sorted.map((l, i) => ({ ...l, z_order: i }));
            const updated: MapMetadataShape = { ...m.metadata, layers: repacked };
            const newVersion = await saveMapMetadata(m.assetId, m.version, updated);
            return ok(s, {
                asset_id: m.assetId,
                moved_layer_id: layerId,
                direction,
                new_order: repacked.map(l => ({ id: l.id, name: l.name, z_order: l.z_order })),
                new_version: newVersion,
                note: 'Layer order updated. Call recompose_map to re-render.',
            });
        } catch (err) {
            return fail(s, err instanceof Error ? err.message : 'move_layer failed');
        }
    },
});

// ── attach_script_to_placement ────────────────────────────────────────

registerTool({
    name: 'attach_script_to_placement',
    description: 'Link an existing .axs script to a map placement so the anchor emitted by export_map_to_scene runs that script at game start. The script file must already exist under the project (create it first with write_game_logic). Pass script_path=null to detach.',
    access: ['build'],
    isReadOnly: false,
    parameters: {
        type: 'object',
        properties: {
            asset_id: { type: 'string', description: 'Map asset id.' },
            placement_id: { type: 'string', description: 'Id of the placement to target (see read_map).' },
            script_path: {
                type: ['string', 'null'],
                description: 'Project-relative .axs path (e.g. "scripts/enemy.axs") or null to detach.',
            },
        },
        required: ['asset_id', 'placement_id'],
    },
    execute: async (ctx, input): Promise<ToolResult> => {
        const s = start();
        try {
            const m = await loadMap(input.asset_id as string, ctx.projectId);
            const placementId = input.placement_id as string;
            const rawPath = input.script_path;
            const scriptPath = typeof rawPath === 'string' ? rawPath.trim() || null : null;
            if (scriptPath !== null && !scriptPath.endsWith('.axs')) {
                return fail(s, `script_path must end in .axs (got "${scriptPath}").`);
            }
            const idx = m.metadata.placements.findIndex(p => p.id === placementId);
            if (idx < 0) return fail(s, `placement "${placementId}" not found.`);
            const next = m.metadata.placements.slice();
            const existing = next[idx];
            if (scriptPath === null) {
                const copy = { ...existing };
                delete copy.script_path;
                next[idx] = copy;
            } else {
                next[idx] = { ...existing, script_path: scriptPath };
            }
            const updated: MapMetadataShape = { ...m.metadata, placements: next };
            const newVersion = await saveMapMetadata(m.assetId, m.version, updated);
            return ok(s, {
                asset_id: m.assetId,
                placement_id: placementId,
                script_path: scriptPath,
                new_version: newVersion,
                note: scriptPath
                    ? 'Script attached. Call export_map_to_scene to emit a scene that runs it.'
                    : 'Script detached.',
            });
        } catch (err) {
            return fail(s, err instanceof Error ? err.message : 'attach_script_to_placement failed');
        }
    },
});

// ── export_map_to_scene ───────────────────────────────────────────────

/** Slug used for generated filenames. Conservative charset so the path survives
 *  Godot resource loading and the translate layer's regex rewrites. */
function mapSlug(name: string): string {
    return (name || 'map').toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'map';
}

/** Godot node name: alphanumeric + underscore, must start with letter. */
function placementNodeName(placementId: string): string {
    const compact = placementId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
    return `Placement_${compact || 'x'}`;
}

registerTool({
    name: 'export_map_to_scene',
    description: 'Export a map as a playable .scene file that the engine can run. Writes (1) an entry in project_files for the composed PNG so it reaches the runtime, (2) a .scene with a Sprite2D showing the map and one Entity2D anchor per placement (with its script attached if set). Requires the map to have been recomposed at least once. Pass set_as_main=true to wire project.axiom so Play boots into this scene.',
    access: ['build'],
    isReadOnly: false,
    parameters: {
        type: 'object',
        properties: {
            asset_id: { type: 'string', description: 'Map asset id.' },
            scene_path: {
                type: 'string',
                description: 'Optional target .scene path. Defaults to "scenes/maps/<slug>.scene".',
            },
            set_as_main: {
                type: 'boolean',
                description: 'If true, updates project.axiom run/main_scene so Play boots into this scene.',
            },
        },
        required: ['asset_id'],
    },
    execute: async (ctx, input): Promise<ToolResult> => {
        const s = start();
        try {
            const admin = getAdmin();
            const assetId = input.asset_id as string;

            const { data: row, error: loadErr } = await admin
                .from('assets')
                .select('id, name, storage_key, project_id, asset_type, width, height, metadata')
                .eq('id', assetId)
                .single();
            if (loadErr || !row) return fail(s, `Map not found: ${assetId}`);
            if (row.project_id !== ctx.projectId) return fail(s, 'Map belongs to another project.');
            if (row.asset_type !== 'map') return fail(s, `Asset is not a map (type=${row.asset_type}).`);
            if (!row.storage_key) return fail(s, 'Map has no composed PNG — call recompose_map first.');

            const rawMeta = (row.metadata as { map?: unknown } | null)?.map;
            const parsed = tryParseMapMetadata(rawMeta);
            if (!parsed.ok) return fail(s, `Map metadata invalid: ${parsed.error}`);
            const meta = parsed.value;

            const slug = mapSlug(row.name);
            const scenePath = (input.scene_path as string | undefined)?.trim() || `scenes/maps/${slug}.scene`;
            const pngPath = `assets/maps/${slug}.png`;
            const nowIso = new Date().toISOString();

            // (1) Register the composed PNG in project_files. Same storage_key
            // as the asset row — no re-upload, no duplication of bytes.
            const { error: pngErr } = await admin.from('project_files').upsert({
                project_id: ctx.projectId,
                path: pngPath,
                content_type: 'binary',
                text_content: null,
                storage_key: row.storage_key,
                size_bytes: 0,
                updated_at: nowIso,
            }, { onConflict: 'project_id,path' });
            if (pngErr) return fail(s, `Failed to register map PNG in project_files: ${pngErr.message}`);

            // (2) Compute per-placement world positions. Matches the same
            // projection math composeIsoMap / composeWangMap use so anchors
            // land on the same cell center the user saw in MapStudio.
            const mapH = row.height ?? meta.grid_h * meta.tile_size;
            const placementNodes: string[] = [];
            let scriptedCount = 0;
            for (const p of meta.placements) {
                let worldX: number;
                let worldY: number;
                if (meta.projection === 'orthogonal') {
                    worldX = (p.grid_x + 0.5) * meta.tile_size;
                    worldY = (p.grid_y + 0.5) * meta.tile_size;
                } else {
                    const offsetX = meta.grid_h * (meta.tile_size / 2);
                    const diamondH = (meta.grid_w + meta.grid_h) * (meta.tile_size / 4);
                    const offsetY = Math.max(0, mapH - diamondH - meta.tile_size / 2);
                    worldX = (p.grid_x - p.grid_y) * (meta.tile_size / 2) + offsetX + meta.tile_size / 2;
                    worldY = (p.grid_x + p.grid_y) * (meta.tile_size / 4) + offsetY + meta.tile_size / 4;
                }
                const name = placementNodeName(p.id);
                const scriptLine = p.script_path ? `\nscript = ExtResource("${p.script_path}")` : '';
                if (p.script_path) scriptedCount++;
                placementNodes.push(
                    `[node name="${name}" type="Entity2D" parent="."]\nposition = Vector2(${Math.round(worldX)}, ${Math.round(worldY)})${scriptLine}`,
                );
            }

            const sceneContent = [
                `[axiom_scene format=3]`,
                ``,
                `[node name="Map_${slug}" type="Entity2D"]`,
                ``,
                `[node name="Terrain" type="Sprite2D" parent="."]`,
                `texture = ExtResource("${pngPath}")`,
                `centered = false`,
                ``,
                ...placementNodes,
            ].join('\n') + '\n';

            const { error: sceneErr } = await admin.from('project_files').upsert({
                project_id: ctx.projectId,
                path: scenePath,
                content_type: 'text',
                text_content: sceneContent,
                storage_key: null,
                size_bytes: sceneContent.length,
                updated_at: nowIso,
            }, { onConflict: 'project_id,path' });
            if (sceneErr) return fail(s, `Failed to write scene: ${sceneErr.message}`);

            // (3) Optionally wire project.axiom's main scene.
            let mainSceneUpdated = false;
            if (input.set_as_main) {
                const { data: projFile } = await admin
                    .from('project_files')
                    .select('text_content')
                    .eq('project_id', ctx.projectId)
                    .eq('path', 'project.axiom')
                    .maybeSingle();
                const current = projFile?.text_content ?? '';
                const resPath = `res://${scenePath}`;
                let updated: string;
                if (/run\/main_scene="[^"]*"/.test(current)) {
                    updated = current.replace(/run\/main_scene="[^"]*"/, `run/main_scene="${resPath}"`);
                } else if (current.trim().length > 0) {
                    // Append under [application] if it exists, else add the section.
                    updated = /\[application\]/.test(current)
                        ? current.replace(/\[application\]/, `[application]\nrun/main_scene="${resPath}"`)
                        : current + `\n[application]\nrun/main_scene="${resPath}"\n`;
                } else {
                    updated = `config_version=5\n\n[application]\nrun/main_scene="${resPath}"\n`;
                }
                const { error: cfgErr } = await admin.from('project_files').upsert({
                    project_id: ctx.projectId,
                    path: 'project.axiom',
                    content_type: 'text',
                    text_content: updated,
                    storage_key: null,
                    size_bytes: updated.length,
                    updated_at: nowIso,
                }, { onConflict: 'project_id,path' });
                if (cfgErr) return fail(s, `Failed to update project.axiom: ${cfgErr.message}`);
                mainSceneUpdated = true;
            }

            return ok(s, {
                asset_id: row.id,
                scene_path: scenePath,
                png_path: pngPath,
                placement_count: meta.placements.length,
                scripted_placements: scriptedCount,
                main_scene_updated: mainSceneUpdated,
                note: 'Scene exported. Press Play — the composed map renders and each placement is an addressable Entity2D (with its script if attached).',
            });
        } catch (err) {
            return fail(s, err instanceof Error ? err.message : 'export_map_to_scene failed');
        }
    },
});

// ── preview_map (vision) ──────────────────────────────────────────────

// Anthropic recommends ≤ 1568 px on the long side for vision. Larger inputs
// get resized server-side; resizing locally first saves tokens + bandwidth.
const MAX_PREVIEW_EDGE = 1568;

registerTool({
    name: 'preview_map',
    description: 'Fetch the composed PNG of a map and return it as a visible image so the agent can literally SEE the current render. Use this when you need to visually judge layout, spot ugly seams, verify the last recompose landed, or reason about spatial composition. Returns the image plus basic metadata (grid, version, dimensions).',
    access: ['build', 'explore'],
    isReadOnly: true,
    isConcurrencySafe: true,
    parameters: {
        type: 'object',
        properties: {
            asset_id: { type: 'string', description: 'The map asset id.' },
            max_edge: {
                type: 'integer',
                description: `Optional. Max pixels on the long edge (default ${MAX_PREVIEW_EDGE}). Smaller = cheaper but blurrier.`,
            },
        },
        required: ['asset_id'],
    },
    execute: async (ctx, input): Promise<ToolResult> => {
        const s = start();
        try {
            const m = await loadMap(input.asset_id as string, ctx.projectId);
            if (!m.storageKey) {
                return fail(s, `Map ${m.assetId} has no composed PNG yet. Call recompose_map first.`);
            }
            const raw = await downloadBuffer(m.storageKey);
            const sharp = (await import('sharp')).default;
            const meta = await sharp(raw).metadata();
            const origW = meta.width ?? 0;
            const origH = meta.height ?? 0;
            const requested = Math.max(64, Math.min(MAX_PREVIEW_EDGE, (input.max_edge as number | undefined) ?? MAX_PREVIEW_EDGE));
            const longEdge = Math.max(origW, origH);
            let buf = raw;
            let outW = origW;
            let outH = origH;
            if (longEdge > requested) {
                const scale = requested / longEdge;
                outW = Math.round(origW * scale);
                outH = Math.round(origH * scale);
                buf = await sharp(raw).resize(outW, outH, { kernel: 'nearest' }).png().toBuffer();
            }
            const summary = {
                asset_id: m.assetId,
                name: m.name,
                version: m.version,
                projection: m.metadata.projection,
                grid: { w: m.metadata.grid_w, h: m.metadata.grid_h },
                original_dimensions: { w: origW, h: origH },
                preview_dimensions: { w: outW, h: outH },
                placement_count: m.metadata.placements.length,
            };
            return {
                callId: '',
                success: true,
                output: summary,
                filesModified: [],
                duration_ms: Date.now() - s,
                contentBlocks: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/png',
                            data: buf.toString('base64'),
                        },
                    },
                    {
                        type: 'text',
                        text: `Map "${m.name}" v${m.version} — ${m.metadata.projection}, ${m.metadata.grid_w}×${m.metadata.grid_h} grid, ${m.metadata.placements.length} placements. Preview shown at ${outW}×${outH}.`,
                    },
                ],
            };
        } catch (err) {
            return fail(s, err instanceof Error ? err.message : 'preview_map failed');
        }
    },
});
