import { z } from 'zod';
import type { MapMetadataShape, MapLayer } from '@/types/asset';

/** Stable id of the auto-created terrain layer. Kept as a constant so both
 *  client and server migration code agree on the bootstrap id. */
export const TERRAIN_LAYER_ID = 'layer_terrain';

/** Normalise layers on read. Pre-layers maps get a terrain layer auto-created
 *  and every untagged placement becomes a member of it. Runs on every read,
 *  so it's safe to call repeatedly — idempotent. */
export function ensureLayers(meta: MapMetadataShape): MapMetadataShape {
    const hasTerrain = meta.layers?.some(l => l.kind === 'terrain') ?? false;
    let layers: MapLayer[] = meta.layers ? [...meta.layers] : [];
    if (!hasTerrain) {
        layers = [
            {
                id: TERRAIN_LAYER_ID,
                name: 'Base',
                kind: 'terrain',
                visible: true,
                locked: false,
                opacity: 1,
                z_order: 0,
            },
            ...layers,
        ];
    }
    // Re-pack z_order so it's always 0-indexed and dense (UI drag-reorder can
    // produce sparse orders over time; repacking on read keeps them tidy).
    layers = [...layers].sort((a, b) => a.z_order - b.z_order).map((l, i) => ({ ...l, z_order: i }));

    // Terrain layer id (used to tag unlabelled placements).
    const terrainId = layers.find(l => l.kind === 'terrain')!.id;
    const validLayerIds = new Set(layers.map(l => l.id));

    const placements = meta.placements.map(p => {
        if (p.layer_id && validLayerIds.has(p.layer_id)) return p;
        return { ...p, layer_id: terrainId };
    });

    // Avoid churning reference equality when nothing changed.
    const layersChanged = JSON.stringify(layers) !== JSON.stringify(meta.layers ?? []);
    const placementsChanged = placements.some((p, i) => p !== meta.placements[i]);
    if (!layersChanged && !placementsChanged) return meta;
    return { ...meta, layers, placements };
}

// Runtime schema for MapMetadataShape. Used at every boundary where
// untrusted metadata crosses (PixelLab responses, client → server save,
// server → DB update). Prevents corrupt shapes from reaching the canvas
// or the assets row.

const TerrainCornerSchema = z.enum(['lower', 'upper', 'transition']);

const WangCornersSchema = z.object({
    NW: TerrainCornerSchema,
    NE: TerrainCornerSchema,
    SW: TerrainCornerSchema,
    SE: TerrainCornerSchema,
});

const MapWangTileSchema = z.object({
    id: z.string().min(1),
    storage_key: z.string().min(1),
    corners: WangCornersSchema,
    name: z.string().optional(),
});

const MapIsoTileSchema = z.object({
    id: z.string().min(1),
    storage_key: z.string().min(1),
    name: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
});

const MapObjectEntrySchema = z.object({
    id: z.string().min(1),
    storage_key: z.string().min(1),
    name: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    prompt: z.string().optional(),
});

// Placements reference EITHER a library object OR a project asset.
const MapObjectPlacementSchema = z.object({
    id: z.string().min(1),
    object_id: z.string().optional(),
    asset_id: z.string().optional(),
    grid_x: z.number().int(),
    grid_y: z.number().int(),
    z_level: z.number().int().nonnegative().optional(),
    layer_id: z.string().optional(),
    script_path: z.string().optional(),
});

const LayerKindSchema = z.enum(['terrain', 'decoration', 'collision', 'overlay']);

const MapLayerSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(60),
    kind: LayerKindSchema,
    visible: z.boolean(),
    locked: z.boolean(),
    opacity: z.number().min(0).max(1),
    z_order: z.number().int(),
});

const TerrainPromptsSchema = z.object({
    lower: z.string(),
    upper: z.string(),
    transition: z.string().optional(),
});

// Grid size caps. Well above anything the UI can produce (32×24 max today)
// but small enough that composeWangMap / composeIsoMap never allocate a
// canvas that exceeds Sharp / browser limits (~16k × 16k).
export const MAX_GRID_DIMENSION = 256;
export const MAX_TILE_SIZE = 128;

export const MapMetadataSchema = z.object({
    projection: z.enum(['orthogonal', 'isometric']),
    tile_size: z.number().int().positive().max(MAX_TILE_SIZE),
    grid_w: z.number().int().positive().max(MAX_GRID_DIMENSION),
    grid_h: z.number().int().positive().max(MAX_GRID_DIMENSION),
    mode: z.enum(['fixed', 'looping']),
    version: z.number().int().nonnegative().optional(),

    // Orthogonal
    corners: z.array(z.array(TerrainCornerSchema)).optional(),
    wang_tiles: z.array(MapWangTileSchema).optional(),
    terrain_prompts: TerrainPromptsSchema.optional(),

    // Isometric
    iso_tiles: z.array(MapIsoTileSchema).optional(),
    iso_grid: z.array(z.array(z.string().nullable())).optional(),
    iso_stack: z.array(z.array(z.array(z.string()))).optional(),

    // Objects (both modes)
    objects_library: z.array(MapObjectEntrySchema),
    placements: z.array(MapObjectPlacementSchema),

    // Layers (optional pre-migration; guaranteed present post-migration).
    layers: z.array(MapLayerSchema).optional(),
});

export type MapMetadataParsed = z.infer<typeof MapMetadataSchema>;

/** Validate + strip unknown fields. Throws with a readable message on failure. */
export function parseMapMetadata(input: unknown): MapMetadataShape {
    const res = MapMetadataSchema.safeParse(input);
    if (!res.success) {
        const issues = res.error.issues.slice(0, 3)
            .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ');
        throw new Error(`Invalid map metadata — ${issues}`);
    }
    return ensureLayers(res.data as MapMetadataShape);
}

/** Non-throwing variant. Returns null on failure so callers can branch on UI vs API responses. */
export function tryParseMapMetadata(input: unknown): { ok: true; value: MapMetadataShape } | { ok: false; error: string } {
    const res = MapMetadataSchema.safeParse(input);
    if (!res.success) {
        const issues = res.error.issues.slice(0, 3)
            .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ');
        return { ok: false, error: `Invalid map metadata — ${issues}` };
    }
    return { ok: true, value: ensureLayers(res.data as MapMetadataShape) };
}

/** Clamp placement grid coords into [0, grid_w-1] × [0, grid_h-1]. Pre-persist
 *  sanitizer so malformed client payloads can't poison the stored metadata. */
export function sanitizePlacements(meta: MapMetadataShape): MapMetadataShape {
    const maxX = meta.grid_w - 1;
    const maxY = meta.grid_h - 1;
    const cleaned = meta.placements.filter(p =>
        Number.isFinite(p.grid_x) && Number.isFinite(p.grid_y)
        && p.grid_x >= 0 && p.grid_x <= maxX
        && p.grid_y >= 0 && p.grid_y <= maxY
        && (typeof p.object_id === 'string' || typeof p.asset_id === 'string'),
    );
    if (cleaned.length === meta.placements.length) return meta;
    return { ...meta, placements: cleaned };
}
