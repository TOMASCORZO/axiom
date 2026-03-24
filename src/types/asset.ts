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
    | 'particle';

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
