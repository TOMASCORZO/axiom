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
**DB:** list_game_tables, describe_game_table, create_game_table, add_column, drop_column, rename_column, alter_column, execute_game_sql
**Assets:** search_free_asset (free, prefer this), generate_sprite (5cr), generate_texture (5cr), generate_animation`;

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
    'execute_game_sql',
];

export const MODE_CREDIT_MULTIPLIER: Record<GameMode, number> = {
    '2d': 1,
    '3d': 3,
};
