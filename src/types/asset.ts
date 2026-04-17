// ── Asset Types ─────────────────────────────────────────────────────

export type AssetType =
    | 'sprite'
    | 'sprite_sheet'
    | 'texture'
    | 'texture_atlas'
    | 'model_3d'
    | 'material'
    | 'animation'
    | 'audio'
    | 'ui_element'
    | 'font'
    | 'particle'
    | 'map';

// ── Map asset shape ────────────────────────────────────────────────
// A map stores either:
//   - ORTHOGONAL (Wang): a per-corner terrain label grid + a 16-tile Wang
//     palette from PixelLab /create-tileset. Auto-tiling looks up the right
//     sprite by corner pattern so edges blend.
//   - ISOMETRIC: a list of iso tile variants + a grid of which variant lives
//     in each cell. Rendered in diamond projection.
// Objects are a library + placements layer on top, shared by both modes.

export type MapMode = 'fixed' | 'looping';
export type MapProjection = 'orthogonal' | 'isometric';
export type TerrainCorner = 'lower' | 'upper' | 'transition';

/** One of the 16 (or 23 with transition) Wang tiles from /create-tileset. */
export interface MapWangTile {
    id: string;                 // uuid from PixelLab
    storage_key: string;
    corners: { NW: TerrainCorner; NE: TerrainCorner; SW: TerrainCorner; SE: TerrainCorner };
    name?: string;
}

/** An isometric (or tiles-pro) tile variant paintable onto cells. */
export interface MapIsoTile {
    id: string;
    storage_key: string;
    name: string;
    width: number;              // natural px
    height: number;
}

/** Reusable object sprite (tree, rock, chest, character, …). */
export interface MapObjectEntry {
    id: string;
    storage_key: string;
    name: string;
    width: number;              // natural width in px
    height: number;
    prompt?: string;
}

export interface MapObjectPlacement {
    id: string;
    /** Reference a map-library object (from /map-objects). Mutually exclusive with asset_id. */
    object_id?: string;
    /** Reference a project asset (sprite/sprite_sheet/animation) dragged onto the map.
     *  Mutually exclusive with object_id. Server resolves this to a storage_key via the assets table. */
    asset_id?: string;
    grid_x: number;             // top-left cell, 0-indexed
    grid_y: number;
    /** Isometric only: stack level the placement sits on top of (0 = ground, 1 = on top of 1 block, …). */
    z_level?: number;
    /** Which layer this placement belongs to. Legacy placements without a
     *  layer_id are auto-assigned to the base terrain layer on read. */
    layer_id?: string;
    /** Optional path (relative to project root) of an Axiom script (.axs) to attach
     *  to this placement's anchor node when the map is exported to a scene. */
    script_path?: string;
}

/** Drawing order + visibility grouping for placements.
 *   - terrain: the single layer that owns corners/iso_stack. Only one per map.
 *     Auto-created on the first read of a pre-layers map.
 *   - decoration: placement-only. Trees, rocks, decals — drawn above terrain.
 *   - collision: placement-only. Usually invisible at render but still stored
 *     (client game code can read them to build collision bodies).
 *   - overlay: placement-only. Fog, UI markers — usually drawn on top of everything. */
export type LayerKind = 'terrain' | 'decoration' | 'collision' | 'overlay';

export interface MapLayer {
    id: string;
    name: string;
    kind: LayerKind;
    visible: boolean;
    locked: boolean;
    /** 0..1. Applied to every placement in this layer when rendering. */
    opacity: number;
    /** Lower = drawn earlier (further back). The terrain layer is always z_order 0. */
    z_order: number;
}

export interface TerrainPrompts {
    lower: string;              // e.g. "grass"
    upper: string;              // e.g. "stone path"
    transition?: string;        // optional blend band, e.g. "mossy edge"
}

export interface MapMetadataShape {
    projection: MapProjection;
    tile_size: number;          // per-cell px
    grid_w: number;             // cell columns
    grid_h: number;             // cell rows
    mode: MapMode;

    // Optimistic-concurrency counter. Incremented server-side on every
    // recompose; the client sends the version it loaded so concurrent saves
    // don't silently overwrite each other. Older maps persisted before this
    // field was introduced read back as undefined → server treats as 0.
    version?: number;

    // ── Orthogonal (Wang auto-tiling) ──
    // Corner grid has (grid_h + 1) rows × (grid_w + 1) cols of terrain labels.
    // For each cell (y,x) the four corners are corners[y][x], [y][x+1],
    // [y+1][x], [y+1][x+1]. The compositor picks the wang_tile with matching
    // corners.
    corners?: TerrainCorner[][];
    wang_tiles?: MapWangTile[];
    terrain_prompts?: TerrainPrompts;

    // ── Isometric ──
    iso_tiles?: MapIsoTile[];
    /** Legacy single-layer grid. Maps generated before stacking live here.
     *  New writes prefer iso_stack — when migrating, each non-null cell becomes a [tileId] stack. */
    iso_grid?: (string | null)[][];
    /** Stacked cells: iso_stack[y][x] = tile ids bottom → top. Empty array = empty cell.
     *  Each level renders offset by tile_size * STACK_STEP_RATIO on Y for a stepped look. */
    iso_stack?: string[][][];

    // ── Objects (both modes) ──
    objects_library: MapObjectEntry[];
    placements: MapObjectPlacement[];

    // ── Layers ──
    // Every map has ≥1 layer after migration. The first one is always the
    // terrain layer (owns corners/iso_stack). Placements reference a layer by
    // layer_id; missing layer_id → assigned to terrain on read.
    layers?: MapLayer[];
}

export type AssetStyle =
    | 'pixel_art'
    | 'hand_drawn'
    | 'vector'
    | 'realistic'
    | 'stylized'
    | 'low_poly'
    | 'pbr'
    | 'hand_painted';

export interface Asset {
    id: string;
    project_id: string;
    name: string;
    asset_type: AssetType;
    storage_key: string;
    thumbnail_key: string | null;
    file_format: string;
    width: number | null;
    height: number | null;
    metadata: AssetMetadata;
    generation_prompt: string | null;
    generation_model: string | null;
    size_bytes: number;
    created_at: string;
}

export interface AssetMetadata {
    // Sprite sheet specific
    frames?: SpriteFrame[];
    frameRate?: number;
    loop?: boolean;
    // 3D model specific
    polycount?: number;
    hasLODs?: boolean;
    materials?: string[];
    // Animation specific
    duration?: number;
    keyframeCount?: number;
    // Audio specific
    sampleRate?: number;
    channels?: number;
    // Map-specific (see MapMetadataShape)
    map?: MapMetadataShape;
    // General
    tags?: string[];
    [key: string]: unknown;
}

export interface SpriteFrame {
    x: number;
    y: number;
    width: number;
    height: number;
    duration: number;
    texture?: string;
}

// ── Generation Request/Response ────────────────────────────────────

export interface AssetGenerationRequest {
    project_id: string;
    prompt: string;
    asset_type: AssetType;
    style: AssetStyle;
    options: Record<string, unknown>;
    target_path: string;
}

export interface AssetGenerationResponse {
    success: boolean;
    asset_id?: string;
    storage_key?: string;
    thumbnail_url?: string;
    error?: string;
    credits_used: number;
}
