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
    object_id: string;
    grid_x: number;             // top-left cell, 0-indexed
    grid_y: number;
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
    iso_grid?: (string | null)[][]; // grid[y][x] → MapIsoTile.id or null

    // ── Objects (both modes) ──
    objects_library: MapObjectEntry[];
    placements: MapObjectPlacement[];
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
