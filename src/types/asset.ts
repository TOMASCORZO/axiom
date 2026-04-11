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
// A map asset stores a tile library, a grid of tile IDs, and any objects
// placed on top. The composed PNG in storage_key is a rendered snapshot;
// editing the map re-composes it from this metadata.

export type MapMode = 'fixed' | 'looping';

export interface MapTileEntry {
    id: string;               // stable client-generated id
    storage_key: string;      // PNG of the tile sprite
    name: string;             // short label shown in the palette
    prompt?: string;          // what the tile was generated from
}

export interface MapObjectEntry {
    id: string;               // stable library id (reusable)
    storage_key: string;      // PNG of the object sprite
    name: string;
    width: number;            // natural width in px (usually == tile_size, may be larger)
    height: number;
    prompt?: string;
}

export interface MapObjectPlacement {
    id: string;               // unique placement id
    object_id: string;        // refers to MapObjectEntry.id
    grid_x: number;           // top-left cell, 0-indexed
    grid_y: number;
}

export interface MapMetadataShape {
    tile_size: number;        // px per cell
    grid_w: number;           // columns
    grid_h: number;           // rows
    mode: MapMode;            // 'fixed' or 'looping' (wraps visually)
    tiles: MapTileEntry[];    // tile library (palette)
    objects_library: MapObjectEntry[]; // object palette
    grid: (string | null)[][]; // grid[y][x] → tile id or null
    placements: MapObjectPlacement[]; // objects placed on the grid
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
