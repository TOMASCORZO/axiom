/**
 * Prompt Composer — lean system prompt builder.
 *
 * Sends only what the agent needs: identity, rules, tool list, project state.
 * Reference material (patterns, GDScript docs, scene format) is NOT included.
 * The LLM knows GDScript from training — we don't need to re-teach it every call.
 */

import { getBasePrompt } from './base';
import { getSceneFormatReference } from './scene-format';
import { getGDScriptReference } from './gdscript-reference';
import { getRealtimeReference } from './realtime-reference';

export type GameMode = '2d' | '3d';

// ── Per-provider identity (kept short) ───────────────────────────

const PROVIDER_HEADERS: Record<string, string> = {
    claude: `You are the Axiom AI Agent. Be concise, direct. Build games using tools, not explanations. Focus on what you built.`,
    gpt: `You are the Axiom AI Agent. Pragmatic game developer. Communicate efficiently, prioritize action over explanation.`,
    gemini: `You are the Axiom AI Agent. Adhere to AxiomScript (GDScript 4.x) conventions. Check existing code before writing.`,
    kimi: `You are the Axiom AI Agent. Build complete games by calling tools. Write FULL code in tool calls, never in chat text.`,
    deepseek: `You are the Axiom AI Agent. Build complete games by calling tools. Write FULL code in tool calls, never in chat text.`,
    default: `You are the Axiom AI Agent. Build games using the Axiom Engine tools.`,
};

// ── Tool descriptions (concise) ──────────────────────────────────

const TOOLS = `## Tools
**Files:** read_file, edit_file, write_file, list_files, search_files, delete_file
**Game:** create_project_config, create_scene, write_game_logic, modify_scene, modify_physics, update_ui_layout, debug_runtime_error, export_build
**Realtime:** configure_realtime (declare chat/rooms/presence/state/events/custom in realtime.axiom.json)
**DB:** list_game_tables, describe_game_table, create_game_table, add_column, drop_column, rename_column, alter_column, add_foreign_key, drop_foreign_key, create_index, drop_index, execute_game_sql
**Assets:** search_free_asset (free, prefer this), generate_sprite (5cr), generate_texture (5cr), generate_animation
**Maps — generation:** generate_map (Wang ortho or isometric, full grid), generate_tileset (raw tiles in any shape — hex/hex_pointy/octagon/square_topdown/isometric), generate_map_object (one sprite, optional style-lock + inpainting against an existing map), generate_iso_tile (one iso-tile variant)
**Maps — editing:** list_maps, read_map, paint_terrain_region (Wang corners), edit_iso_cells, place_objects_on_map, remove_placements_from_map, extend_map_grid, add_iso_tile_to_map, add_object_to_map, recompose_map, preview_map
**Maps — layers:** list_layers, create_layer, delete_layer, update_layer, move_layer, attach_script_to_placement, export_map_to_scene
**Map tips:** prefer editing an existing map (paint/place/extend) over re-generating. generate_map exposes art-direction knobs (outline, shading, detail, transition_size, seed) plus iso-only ones (iso_variant_prompts up to 16, iso_tile_height, iso_tile_view, iso_tile_view_angle, iso_depth_ratio). For non-isometric/non-Wang maps (hex grids, octagon, square top-down) use generate_tileset to get raw tiles. For surgical region edits on an existing map use generate_map_object with background_map_path + inpaint_region (rectangle/oval) or mask_path (arbitrary shape via b/w PNG mask).

**Mobile target:** the runtime works on web AND mobile (touch input is auto-forwarded as both InputEventScreenTouch and synthesized mouse events). When the user says "mobile game" or "phone game", call create_project_config with target='mobile_portrait' (or 'mobile_landscape') — that preset auto-picks viewport size, stretch_aspect, and orientation so the game fills any device automatically. Use 'responsive' for UI-heavy games that should expand to fill any aspect ratio via Control anchors, 'desktop' for traditional 16:9 web games. Always: (1) avoid hover-only interactions on mobile; (2) size touch targets ≥ 48×48 px; (3) prefer Control nodes with anchor presets over hardcoded positions. PWA install + service worker are wired so games can be added to the home screen — no separate Android/iOS build pipeline yet (web/PWA only).`;

const TOOLS_3D_EXTRA = `, generate_3d_model (10cr)`;

// ── Main builder ────────────────────────────────────────────────────

export function buildSystemPrompt(
    fileList: string,
    conversationHistory: string,
    gameMode: GameMode,
    providerId?: string,
): string {
    const is3D = gameMode === '3d';
    const modeLabel = is3D ? '3D' : '2D';
    const header = PROVIDER_HEADERS[providerId ?? 'default'] ?? PROVIDER_HEADERS.default;
    const today = new Date().toISOString().split('T')[0];

    const sections = [
        header,
        getBasePrompt(modeLabel, is3D),
        `## Environment\nMode: ${modeLabel} | Engine: Axiom (WASM) | Scripts: .axs (GDScript 4.x) | Scenes: .scene | Date: ${today}`,
        getSceneFormatReference(is3D),
        getGDScriptReference(),
        getRealtimeReference(),
        TOOLS + (is3D ? TOOLS_3D_EXTRA : ''),
        fileList ? `## Project Files\n${fileList}` : '## Project Files\n(empty — start fresh)',
        conversationHistory ? `## Recent Context\n${conversationHistory}` : '',
    ];

    return sections.filter(Boolean).join('\n\n');
}

export const TOOLS_2D = [
    'read_file', 'edit_file', 'write_file', 'list_files', 'search_files', 'delete_file',
    'create_scene', 'write_game_logic', 'modify_scene', 'modify_physics',
    'search_free_asset', 'generate_sprite', 'generate_texture', 'generate_animation',
    'update_ui_layout', 'debug_runtime_error', 'export_build', 'create_project_config',
    'configure_realtime',
    'list_game_tables', 'describe_game_table', 'create_game_table',
    'add_column', 'drop_column', 'rename_column', 'alter_column',
    'add_foreign_key', 'drop_foreign_key', 'create_index', 'drop_index',
    'execute_game_sql',
];

export const TOOLS_3D = [
    'read_file', 'edit_file', 'write_file', 'list_files', 'search_files', 'delete_file',
    'create_scene', 'write_game_logic', 'modify_scene', 'modify_physics',
    'search_free_asset', 'generate_sprite', 'generate_texture', 'generate_3d_model', 'generate_animation',
    'update_ui_layout', 'debug_runtime_error', 'export_build', 'create_project_config',
    'configure_realtime',
    'list_game_tables', 'describe_game_table', 'create_game_table',
    'add_column', 'drop_column', 'rename_column', 'alter_column',
    'add_foreign_key', 'drop_foreign_key', 'create_index', 'drop_index',
    'execute_game_sql',
];

export const MODE_CREDIT_MULTIPLIER: Record<GameMode, number> = {
    '2d': 1,
    '3d': 3,
};
