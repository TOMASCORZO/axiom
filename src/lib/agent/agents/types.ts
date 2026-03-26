/**
 * Agent Types — OpenCode-faithful agent definitions.
 *
 * OpenCode agents:
 * - build: Full tool access, the default agent
 * - plan: Read-only, analysis and planning only
 * - explore: Fast read-only codebase exploration
 *
 * Each agent has permission sets, max iterations, and system prompt additions.
 */

export type AgentType = 'build' | 'plan' | 'explore';

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

export const AGENT_DEFS: Record<AgentType, AgentDef> = {
    build: {
        type: 'build',
        name: 'Build',
        description: 'The default agent. Executes tools based on configured permissions.',
        maxIterations: 25,
        deniedTools: [],
        systemSuffix: `## Agent Mode: BUILD
You have FULL access to all tools. You can:
- Read, write, edit, and delete project files
- Create scenes, scripts, and configurations
- Search and generate game assets
- Modify scene nodes and physics
- Debug runtime errors

When you receive a task:
1. First READ existing files to understand the project state
2. PLAN what changes are needed
3. EXECUTE changes using tools
4. VERIFY by reading back what you wrote if needed

Use edit_file for small changes to existing files. Use write_file or write_game_logic for new files or complete rewrites. Always provide COMPLETE code — never use placeholder comments like "// rest of code here".`,
        forceFirstTool: false,
    },
    plan: {
        type: 'plan',
        name: 'Plan',
        description: 'Plan mode. Disallows all edit tools.',
        maxIterations: 10,
        deniedTools: ['edit_file', 'write_file', 'delete_file', 'write_game_logic', 'create_scene', 'modify_scene', 'modify_physics', 'update_ui_layout', 'create_project_config', 'generate_sprite', 'generate_texture', 'generate_3d_model', 'generate_animation', 'export_build'],
        systemSuffix: `## Agent Mode: PLAN
You are in READ-ONLY mode. You can:
- Read project files
- List and search files
- Analyze code and suggest improvements
- Debug errors (analysis only)

You CANNOT create, edit, or delete files. Provide detailed analysis and recommendations.`,
        forceFirstTool: false,
    },
    explore: {
        type: 'explore',
        name: 'Explore',
        description: 'Fast agent specialized for exploring codebases. Read-only, optimized for quick searches.',
        maxIterations: 5,
        deniedTools: ['edit_file', 'write_file', 'delete_file', 'write_game_logic', 'create_scene', 'modify_scene', 'modify_physics', 'update_ui_layout', 'create_project_config', 'generate_sprite', 'generate_texture', 'generate_3d_model', 'generate_animation', 'export_build', 'search_free_asset'],
        systemSuffix: `## Agent Mode: EXPLORE
Fast codebase exploration. You can ONLY read and search files. Be concise and direct.`,
        forceFirstTool: false,
    },
};
