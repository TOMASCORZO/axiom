import { z } from 'zod';

// ── Tool Definition Types ──────────────────────────────────────────

export type ToolSideEffect = 'fs_write' | 'fs_delete' | 'storage_upload' | 'engine_reload';

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: z.ZodType;
    sideEffects: ToolSideEffect[];
    costCredits: number;
    requiresConfirmation: boolean;
}

export interface ToolCall {
    id: string;
    tool: string;
    input: Record<string, unknown>;
    timestamp: string;
}

export interface ToolFileData {
    path: string;
    content: string;
    size_bytes: number;
    content_type: string;
}

export interface ToolResult {
    callId?: string;
    success: boolean;
    output: any;
    filesModified?: string[];
    fileContents?: ToolFileData[];
    error?: string;
    duration_ms: number;
}

// ── Agent Log Types ────────────────────────────────────────────────

export type AgentRole = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system';

export interface AgentLog {
    id: string;
    project_id: string;
    user_id: string;
    conversation_id: string;
    role: AgentRole;
    content: string;
    tool_name: string | null;
    tool_input: Record<string, unknown> | null;
    tool_output: Record<string, unknown> | null;
    tokens_used: number;
    duration_ms: number;
    created_at: string;
}

// ── Chat Message Types ─────────────────────────────────────────────

/** CC-style ordered content blocks for inline rendering */
export type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'thinking'; text: string; isStreaming?: boolean }
    | { type: 'tool_use'; toolCall: ToolCallDisplay };

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    /** Ordered content blocks for CC-style inline rendering */
    blocks?: ContentBlock[];
    toolCalls?: ToolCallDisplay[];
    reasoning?: string;
    timestamp: string;
    isStreaming?: boolean;
}

export interface ToolCallDisplay {
    id: string;
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    input: Record<string, unknown>;
    output?: any;
    error?: string;
    filesModified?: string[];
    duration_ms?: number;
}

// ── Core Message Types (Query Engine) ─────────────────────────────

export interface Block { type: string; }
export interface TextBlock extends Block { type: 'text'; text: string; }
export interface ToolUseBlock extends Block {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
}
export interface ToolResultBlock extends Block {
    type: 'tool_result';
    tool_use_id: string;
    content: string;
    is_error?: boolean;
}

export interface AssistantMessage {
    type: 'assistant';
    uuid: string; // internal identifier
    apiError?: string;
    message: {
        content: Array<TextBlock | ToolUseBlock>;
        stop_reason?: string;
    };
}

export interface UserMessage {
    type: 'user';
    uuid: string;
    message: {
        content: string | Array<TextBlock | ToolResultBlock>;
    };
}

export interface SystemMessage {
    type: 'system';
    uuid: string;
    subtype?: 'compact_boundary' | 'local_command';
    content: string;
}

export type Message = AssistantMessage | UserMessage | SystemMessage;

export type StreamEvent = 
    | { type: 'message_start', message: { usage: { inputTokens: number; outputTokens: number } } }
    | { type: 'content_block_start', index: number, block: { type: 'text' } | { type: 'tool_use', id: string, name: string } }
    | { type: 'content_block_delta', index: number, delta: { type: 'text_delta', text: string } | { type: 'reasoning_delta', text: string } | { type: 'input_json_delta', partial_json: string } }
    | { type: 'content_block_stop', index: number }
    | { type: 'message_delta', usage: { outputTokens: number }, stop_reason?: string }
    | { type: 'message_stop' }
    | { type: 'error', error: { type: string, message: string } };

// ── Conversation Types ────────────────────────────────────────────

export interface ConversationSummary {
    id: string;
    title: string;
    messageCount: number;
    createdAt: string;
    lastMessageAt: string;
}

// ── Memory Types ───────────────────────────────────────────────────

export interface ProjectMemory {
    projectId: string;
    fileTree: import('./project').FileNode[];
    sceneGraph: SceneNode[];
    scriptIndex: ScriptMeta[];
    lastError: RuntimeError | null;
    pendingChanges: FileDiff[];
}

export interface SceneNode {
    name: string;
    type: string;
    children: SceneNode[];
    properties: Record<string, unknown>;
    scriptPath?: string;
}

export interface ScriptMeta {
    path: string;
    className: string | null;
    extends: string;
    functions: string[];
    signals: string[];
    exports: string[];
}

export interface RuntimeError {
    message: string;
    file: string;
    line: number;
    stack?: string;
    timestamp: string;
}

export interface FileDiff {
    path: string;
    action: 'created' | 'modified' | 'deleted';
    before?: string;
    after?: string;
}

// ── Tool Parameter Schemas (Zod) ───────────────────────────────────

export const CreateSceneSchema = z.object({
    scene_name: z.string().describe('Name of the scene file (without extension)'),
    root_node_type: z.string().default('Entity2D').describe('Root node type'),
    target_path: z.string().describe('Path in project, e.g. scenes/main.scene'),
});

export const SearchFreeAssetSchema = z.object({
    query: z.string().describe('Search query describing the asset needed (e.g. "platformer character sprite", "grass tileset")'),
    asset_type: z.enum(['sprite', 'texture', 'tileset', 'sprite_sheet', 'background', 'icon', 'sound', 'model_3d']).describe('Type of asset to search for'),
    target_path: z.string().describe('Path in project to save the asset, e.g. assets/sprites/hero.png'),
    max_results: z.number().int().default(5).describe('Maximum number of results to return for the agent to choose from'),
});

export const GenerateSpriteSchema = z.object({
    prompt: z.string().describe('Visual description of the sprite'),
    style: z.enum(['pixel_art', 'hand_drawn', 'vector', 'realistic', 'stylized']).default('stylized'),
    width: z.number().int().default(128),
    height: z.number().int().default(128),
    transparent_bg: z.boolean().default(true),
    target_path: z.string().describe('Path in project, e.g. assets/sprites/hero.png'),
});

export const GenerateTextureSchema = z.object({
    prompt: z.string().describe('Visual description of the texture'),
    style: z.enum(['pbr', 'stylized', 'pixel', 'hand_painted']).default('stylized'),
    width: z.number().int().default(512),
    height: z.number().int().default(512),
    tileable: z.boolean().default(false),
    target_path: z.string().describe('Path in project, e.g. assets/textures/grass.png'),
});

export const Generate3DModelSchema = z.object({
    prompt: z.string().describe('Description of the 3D model'),
    topology: z.enum(['low_poly', 'standard', 'high_poly']).default('standard'),
    textured: z.boolean().default(true),
    target_path: z.string().describe('Path in project, e.g. assets/models/tree.glb'),
});

export const GenerateAnimationSchema = z.object({
    prompt: z.string().describe('Description of the animation'),
    type: z.enum(['sprite_frames', 'skeletal', 'keyframe']).default('sprite_frames'),
    frame_count: z.number().int().default(4),
    fps: z.number().int().default(12),
    loop: z.boolean().default(true),
    base_sprite_path: z.string().optional().describe('Existing sprite to animate'),
    target_path: z.string().describe('Output path'),
});

export const WriteGameLogicSchema = z.object({
    file_path: z.string().describe('Script path, e.g. scripts/player.axs'),
    description: z.string().describe('What the script should do'),
    extends_type: z.string().default('Entity2D').describe('Base class to extend'),
    existing_content: z.string().optional().describe('Current file content to modify'),
});

export const ModifySceneSchema = z.object({
    scene_path: z.string().describe('Path to the .scene file'),
    operations: z.array(z.object({
        action: z.enum(['add_node', 'remove_node', 'modify_property', 'attach_script']),
        target_node: z.string().optional(),
        node_type: z.string().optional(),
        node_name: z.string().optional(),
        property: z.string().optional(),
        value: z.unknown().optional(),
        script_path: z.string().optional(),
    })),
});

export const ModifyPhysicsSchema = z.object({
    scene_path: z.string().describe('Scene to modify physics on'),
    node_name: z.string().describe('Node to configure'),
    physics_type: z.enum(['static', 'rigid', 'kinematic', 'area']),
    collision_shape: z.enum(['rectangle', 'circle', 'capsule', 'polygon']).optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
});

export const UpdateUILayoutSchema = z.object({
    scene_path: z.string().describe('UI scene path'),
    operations: z.array(z.object({
        action: z.enum(['add_element', 'remove_element', 'modify_style', 'set_text']),
        element_type: z.string().optional(),
        element_name: z.string().optional(),
        property: z.string().optional(),
        value: z.unknown().optional(),
    })),
});

export const DebugRuntimeErrorSchema = z.object({
    error_message: z.string(),
    error_file: z.string(),
    error_line: z.number().int(),
    stack_trace: z.string().optional(),
});

export const ExportBuildSchema = z.object({
    platform: z.enum(['web', 'windows', 'linux', 'macos', 'android']).default('web'),
    optimize: z.boolean().default(true),
});

// ── Tool Registry ──────────────────────────────────────────────────

export const TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
    create_scene: {
        name: 'create_scene',
        description: 'Create a new .scene file with a root node',
        parameters: CreateSceneSchema,
        sideEffects: ['fs_write', 'engine_reload'],
        costCredits: 0,
        requiresConfirmation: false,
    },
    search_free_asset: {
        name: 'search_free_asset',
        description: 'Search open-source asset libraries (OpenGameArt, Kenney, itch.io) for free game assets. Costs 0 credits. PREFER this over generate_sprite/generate_texture when the user has a free plan or when generic/common assets are needed (platformer tiles, UI icons, basic characters, backgrounds). Only use AI generation when the user needs something very specific or custom.',
        parameters: SearchFreeAssetSchema,
        sideEffects: ['storage_upload', 'fs_write'],
        costCredits: 0,
        requiresConfirmation: false,
    },
    generate_sprite: {
        name: 'generate_sprite',
        description: 'AI-generate a CUSTOM 2D sprite image and add it to the project. Costs 5 credits. Only use when search_free_asset cannot find what is needed or the user explicitly requests AI-generated art.',
        parameters: GenerateSpriteSchema,
        sideEffects: ['storage_upload', 'fs_write'],
        costCredits: 5,
        requiresConfirmation: false,
    },
    generate_texture: {
        name: 'generate_texture',
        description: 'AI-generate a texture and add it to the project',
        parameters: GenerateTextureSchema,
        sideEffects: ['storage_upload', 'fs_write'],
        costCredits: 5,
        requiresConfirmation: false,
    },
    generate_3d_model: {
        name: 'generate_3d_model',
        description: 'AI-generate a 3D model (GLB) and add it to the project',
        parameters: Generate3DModelSchema,
        sideEffects: ['storage_upload', 'fs_write'],
        costCredits: 10,
        requiresConfirmation: false,
    },
    generate_animation: {
        name: 'generate_animation',
        description: 'Generate animation frames or keyframes for a sprite/model',
        parameters: GenerateAnimationSchema,
        sideEffects: ['storage_upload', 'fs_write'],
        costCredits: 8,
        requiresConfirmation: false,
    },
    write_game_logic: {
        name: 'write_game_logic',
        description: 'Write or modify an AxiomScript (.axs) file',
        parameters: WriteGameLogicSchema,
        sideEffects: ['fs_write', 'engine_reload'],
        costCredits: 1,
        requiresConfirmation: false,
    },
    modify_scene: {
        name: 'modify_scene',
        description: 'Add, remove, or modify nodes in a scene file',
        parameters: ModifySceneSchema,
        sideEffects: ['fs_write', 'engine_reload'],
        costCredits: 0,
        requiresConfirmation: false,
    },
    modify_physics: {
        name: 'modify_physics',
        description: 'Configure physics properties on scene nodes',
        parameters: ModifyPhysicsSchema,
        sideEffects: ['fs_write', 'engine_reload'],
        costCredits: 0,
        requiresConfirmation: false,
    },
    update_ui_layout: {
        name: 'update_ui_layout',
        description: 'Modify UI scene elements (layout, styling, text)',
        parameters: UpdateUILayoutSchema,
        sideEffects: ['fs_write', 'engine_reload'],
        costCredits: 0,
        requiresConfirmation: false,
    },
    debug_runtime_error: {
        name: 'debug_runtime_error',
        description: 'Analyze a runtime error and generate a fix',
        parameters: DebugRuntimeErrorSchema,
        sideEffects: ['fs_write'],
        costCredits: 1,
        requiresConfirmation: false,
    },
    export_build: {
        name: 'export_build',
        description: 'Export the project as a playable build',
        parameters: ExportBuildSchema,
        sideEffects: ['storage_upload'],
        costCredits: 0,
        requiresConfirmation: true,
    },
};
