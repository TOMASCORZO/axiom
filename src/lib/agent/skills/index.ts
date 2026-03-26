/**
 * Godogen-style Skills — multi-step pipelines for game generation.
 *
 * Skills are pre-built sequences of tool calls that handle complex tasks
 * like generating a full game from a description.
 */

import type { GameMode } from '../prompts';

export interface SkillStep {
    tool: string;
    input: Record<string, unknown>;
    description: string;
}

export interface Skill {
    name: string;
    description: string;
    steps: (params: SkillParams) => SkillStep[];
}

interface SkillParams {
    gameName: string;
    gameDescription: string;
    gameMode: GameMode;
    scenes?: string[];
    scripts?: string[];
}

/**
 * Generate a complete game — Godogen-style pipeline:
 * 1. Create project config
 * 2. Create scenes
 * 3. Write scripts with full logic
 * 4. Modify scenes to attach scripts and configure nodes
 * 5. Search/generate assets
 */
export const GENERATE_GAME: Skill = {
    name: 'generate_game',
    description: 'Generate a complete game from a description',
    steps: (params) => {
        const { gameName, gameDescription, gameMode } = params;
        const is3D = gameMode === '3d';
        const rootType = is3D ? 'Entity3D' : 'Entity2D';

        return [
            // Step 1: Project config
            {
                tool: 'create_project_config',
                input: {
                    project_name: gameName,
                    main_scene: 'scenes/main.scene',
                    display_width: 1280,
                    display_height: 720,
                    game_mode: gameMode,
                },
                description: `Create project config for "${gameName}"`,
            },
            // Step 2: Main scene
            {
                tool: 'create_scene',
                input: {
                    scene_name: 'Main',
                    root_node_type: rootType,
                    target_path: 'scenes/main.scene',
                },
                description: 'Create main scene',
            },
        ];
        // The agent will continue with write_game_logic and modify_scene
        // based on what the game needs — the skill provides the skeleton,
        // the LLM fills in the details.
    },
};

/**
 * Fix a runtime error — diagnostic pipeline:
 * 1. Debug the error
 * 2. Read the offending file
 * 3. Write the fix
 */
export const FIX_ERROR: Skill = {
    name: 'fix_error',
    description: 'Diagnose and fix a runtime error',
    steps: (params) => {
        return [
            {
                tool: 'debug_runtime_error',
                input: {
                    error_message: params.gameDescription,
                    error_file: params.scripts?.[0] ?? 'unknown',
                    error_line: 0,
                },
                description: 'Analyze the runtime error',
            },
        ];
    },
};

/**
 * Add a feature to an existing game — enhancement pipeline:
 * 1. Create new script
 * 2. Modify scene to integrate
 */
export const ADD_FEATURE: Skill = {
    name: 'add_feature',
    description: 'Add a new feature to an existing game',
    steps: (params) => {
        return [
            {
                tool: 'write_game_logic',
                input: {
                    file_path: `scripts/${params.gameName.toLowerCase().replace(/\s+/g, '_')}.axs`,
                    description: params.gameDescription,
                    extends_type: params.gameMode === '3d' ? 'Entity3D' : 'Entity2D',
                },
                description: `Write script for: ${params.gameDescription}`,
            },
        ];
    },
};

export const ALL_SKILLS: Record<string, Skill> = {
    generate_game: GENERATE_GAME,
    fix_error: FIX_ERROR,
    add_feature: ADD_FEATURE,
};

/**
 * Detect which skill (if any) matches the user's message.
 * Returns null if no skill matches — agent uses normal ReAct loop.
 */
export function detectSkill(message: string): { skill: Skill; params: Partial<SkillParams> } | null {
    const lower = message.toLowerCase();

    // Detect "make/create/build a game" pattern
    if (/(?:make|create|build|generate|haz|crea|hacer)\s+(?:a |an |un |una |me )?\s*(?:game|juego|proyecto)/i.test(lower)) {
        // Extract game name from quotes or after "called/named"
        const nameMatch = message.match(/(?:called|named|llamado|titulado)\s+["']?([^"'\n,]+)["']?/i)
            || message.match(/["']([^"']+)["']/);
        const gameName = nameMatch?.[1]?.trim() || 'My Game';

        return {
            skill: GENERATE_GAME,
            params: {
                gameName,
                gameDescription: message,
            },
        };
    }

    // Detect error fixing
    if (/(?:fix|solve|debug|error|bug|crash|arregla|soluciona)/i.test(lower)) {
        return {
            skill: FIX_ERROR,
            params: { gameDescription: message },
        };
    }

    // Detect "add feature" pattern
    if (/(?:add|implement|agrega|añade|implement)\s+(?:a |an |un |una )?/i.test(lower)
        && /(?:feature|system|mechanic|función|sistema|mecánica)/i.test(lower)) {
        return {
            skill: ADD_FEATURE,
            params: { gameDescription: message },
        };
    }

    return null;
}
