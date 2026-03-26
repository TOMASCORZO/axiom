/**
 * Agent Types — OpenCode-faithful agent definitions.
 *
 * OpenCode agents:
 * - build: Full tool access, the default agent
 * - plan: Read-only, analysis and planning only
 * - explore: Fast read-only codebase exploration
 * - compaction: Summarizes long conversations to compress context
 * - summary: Generates PR-style summaries of sessions
 *
 * Each agent has permission sets, max iterations, and system prompt additions.
 * System prompts are loaded from physical .txt files (OpenCode pattern).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

export type AgentType = 'build' | 'plan' | 'explore' | 'compaction' | 'summary';

export interface AgentDef {
    type: AgentType;
    name: string;
    description: string;
    maxIterations: number;
    systemSuffix: string;
    forceFirstTool: boolean;
    /** Tools this agent CANNOT use */
    deniedTools: string[];
}

/**
 * Load a prompt from a .txt file in the prompts directory.
 * Falls back to a default string if the file is not found.
 */
function loadPrompt(name: string, fallback: string = ''): string {
    try {
        const promptPath = join(__dirname, 'prompts', `${name}.txt`);
        return readFileSync(promptPath, 'utf-8');
    } catch {
        return fallback;
    }
}

export const AGENT_DEFS: Record<AgentType, AgentDef> = {
    build: {
        type: 'build',
        name: 'Build',
        description: 'The default agent. Executes tools based on configured permissions.',
        maxIterations: 25,
        deniedTools: [],
        systemSuffix: loadPrompt('build', '## Agent Mode: BUILD\nYou have FULL access to all tools. Always use tools to build — never respond with text only.'),
        forceFirstTool: true,
    },
    plan: {
        type: 'plan',
        name: 'Plan',
        description: 'Plan mode. Disallows all edit tools.',
        maxIterations: 10,
        deniedTools: ['edit_file', 'write_file', 'delete_file', 'write_game_logic', 'create_scene', 'modify_scene', 'modify_physics', 'update_ui_layout', 'create_project_config', 'generate_sprite', 'generate_texture', 'generate_3d_model', 'generate_animation', 'export_build'],
        systemSuffix: loadPrompt('plan', '## Agent Mode: PLAN\nYou are in READ-ONLY mode.'),
        forceFirstTool: false,
    },
    explore: {
        type: 'explore',
        name: 'Explore',
        description: 'Fast agent specialized for exploring codebases. Read-only, optimized for quick searches.',
        maxIterations: 5,
        deniedTools: ['edit_file', 'write_file', 'delete_file', 'write_game_logic', 'create_scene', 'modify_scene', 'modify_physics', 'update_ui_layout', 'create_project_config', 'generate_sprite', 'generate_texture', 'generate_3d_model', 'generate_animation', 'export_build', 'search_free_asset'],
        systemSuffix: loadPrompt('explore', '## Agent Mode: EXPLORE\nFast codebase exploration.'),
        forceFirstTool: false,
    },
    compaction: {
        type: 'compaction',
        name: 'Compaction',
        description: 'Summarizes long conversations to compress context and free token budget.',
        maxIterations: 1,
        deniedTools: ['edit_file', 'write_file', 'delete_file', 'write_game_logic', 'create_scene', 'modify_scene', 'modify_physics', 'update_ui_layout', 'create_project_config', 'generate_sprite', 'generate_texture', 'generate_3d_model', 'generate_animation', 'export_build', 'search_free_asset'],
        systemSuffix: loadPrompt('compaction', 'Summarize the conversation concisely.'),
        forceFirstTool: false,
    },
    summary: {
        type: 'summary',
        name: 'Summary',
        description: 'Generates PR-style summaries of agent sessions.',
        maxIterations: 1,
        deniedTools: ['edit_file', 'write_file', 'delete_file', 'write_game_logic', 'create_scene', 'modify_scene', 'modify_physics', 'update_ui_layout', 'create_project_config', 'generate_sprite', 'generate_texture', 'generate_3d_model', 'generate_animation', 'export_build', 'search_free_asset'],
        systemSuffix: loadPrompt('summary', 'Summarize what was done in this conversation.'),
        forceFirstTool: false,
    },
};
