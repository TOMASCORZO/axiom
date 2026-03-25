/**
 * Axiom Agent — Orchestrator
 *
 * Full ReAct (Reasoning + Acting) loop with multi-provider support.
 * Supported providers: Claude (Anthropic), GPT (OpenAI), Kimi K2.5 (Moonshot).
 * The loop: User message → LLM reasons → calls tools → sees results → reasons again → responds.
 * Maximum 10 iterations to prevent infinite loops.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { dispatchTool } from './tools';
import { TOOL_DEFINITIONS } from '@/types/agent';
import type { ToolResult } from '@/types/agent';

// ── Provider Types ─────────────────────────────────────────────────

export type AgentProvider = 'claude' | 'gpt' | 'kimi';

export const PROVIDER_INFO: Record<AgentProvider, { label: string; model: string; color: string }> = {
    claude: { label: 'Claude Sonnet 4', model: 'claude-sonnet-4-20250514', color: 'violet' },
    gpt: { label: 'GPT-5.4', model: 'gpt-5.4', color: 'green' },
    kimi: { label: 'Kimi K2.5', model: 'kimi-k2.5', color: 'blue' },
};

// ── Anthropic API Types ────────────────────────────────────────────

interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicBlock[];
}

type AnthropicBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicTool {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}

interface AnthropicResponse {
    id: string;
    content: AnthropicBlock[];
    stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
    usage: { input_tokens: number; output_tokens: number };
}

// ── OpenAI-Compatible Types (GPT & Kimi K2.5) ─────────────────────

interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
}

interface OpenAIToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

interface OpenAITool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

interface OpenAIResponse {
    id: string;
    choices: Array<{
        message: {
            role: 'assistant';
            content: string | null;
            reasoning_content?: string | null;
            tool_calls?: OpenAIToolCall[];
        };
        finish_reason: 'stop' | 'tool_calls' | 'length';
    }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ── Tool Schema Conversion ─────────────────────────────────────────

function zodToJsonSchema(toolName: string): Record<string, unknown> {
    // Map our Zod schemas to JSON Schema for Anthropic
    const schemas: Record<string, Record<string, unknown>> = {
        create_scene: {
            type: 'object',
            properties: {
                scene_name: { type: 'string', description: 'Name of the scene file (without extension)' },
                root_node_type: { type: 'string', description: 'Root node type (e.g. Entity2D, Entity3D, Control)', default: 'Entity2D' },
                target_path: { type: 'string', description: 'Path in project, e.g. scenes/main.scene' },
            },
            required: ['scene_name', 'target_path'],
        },
        search_free_asset: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query describing the asset needed (e.g. "platformer character sprite", "grass tileset")' },
                asset_type: { type: 'string', enum: ['sprite', 'texture', 'tileset', 'sprite_sheet', 'background', 'icon', 'sound', 'model_3d'], description: 'Type of asset to search for' },
                target_path: { type: 'string', description: 'Path in project to save the asset, e.g. assets/sprites/hero.png' },
                max_results: { type: 'integer', default: 5, description: 'Maximum number of results to return' },
            },
            required: ['query', 'asset_type', 'target_path'],
        },
        generate_sprite: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Visual description of the sprite to generate' },
                style: { type: 'string', enum: ['pixel_art', 'hand_drawn', 'vector', 'realistic', 'stylized'], default: 'stylized' },
                width: { type: 'integer', default: 128 },
                height: { type: 'integer', default: 128 },
                transparent_bg: { type: 'boolean', default: true },
                target_path: { type: 'string', description: 'Path in project, e.g. assets/sprites/hero.png' },
            },
            required: ['prompt', 'target_path'],
        },
        generate_texture: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Visual description of the texture' },
                style: { type: 'string', enum: ['pbr', 'stylized', 'pixel', 'hand_painted'], default: 'stylized' },
                width: { type: 'integer', default: 512 },
                height: { type: 'integer', default: 512 },
                tileable: { type: 'boolean', default: false },
                target_path: { type: 'string', description: 'Path in project, e.g. assets/textures/grass.png' },
            },
            required: ['prompt', 'target_path'],
        },
        generate_3d_model: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Description of the 3D model to generate' },
                topology: { type: 'string', enum: ['low_poly', 'standard', 'high_poly'], default: 'standard' },
                textured: { type: 'boolean', default: true },
                target_path: { type: 'string', description: 'Path in project, e.g. assets/models/tree.glb' },
            },
            required: ['prompt', 'target_path'],
        },
        generate_animation: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Description of the animation' },
                type: { type: 'string', enum: ['sprite_frames', 'skeletal', 'keyframe'], default: 'sprite_frames' },
                frame_count: { type: 'integer', default: 4 },
                fps: { type: 'integer', default: 12 },
                loop: { type: 'boolean', default: true },
                base_sprite_path: { type: 'string', description: 'Existing sprite to animate' },
                target_path: { type: 'string', description: 'Output path' },
            },
            required: ['prompt', 'target_path'],
        },
        write_game_logic: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Script path, e.g. scripts/player.axs' },
                description: { type: 'string', description: 'What the script should do' },
                code_content: { type: 'string', description: 'The full AxiomScript code to write to the file' },
                extends_type: { type: 'string', default: 'Entity2D', description: 'Base class to extend' },
            },
            required: ['file_path', 'description', 'code_content'],
        },
        modify_scene: {
            type: 'object',
            properties: {
                scene_path: { type: 'string', description: 'Path to the .scene file' },
                operations: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            action: { type: 'string', enum: ['add_node', 'remove_node', 'modify_property', 'attach_script'] },
                            target_node: { type: 'string' },
                            node_type: { type: 'string' },
                            node_name: { type: 'string' },
                            property: { type: 'string' },
                            value: {},
                            script_path: { type: 'string' },
                        },
                        required: ['action'],
                    },
                },
            },
            required: ['scene_path', 'operations'],
        },
        modify_physics: {
            type: 'object',
            properties: {
                scene_path: { type: 'string', description: 'Scene to modify physics on' },
                node_name: { type: 'string', description: 'Node to configure' },
                physics_type: { type: 'string', enum: ['static', 'rigid', 'kinematic', 'area'] },
                collision_shape: { type: 'string', enum: ['rectangle', 'circle', 'capsule', 'polygon'] },
                properties: { type: 'object', description: 'Additional physics properties' },
            },
            required: ['scene_path', 'node_name', 'physics_type'],
        },
        update_ui_layout: {
            type: 'object',
            properties: {
                scene_path: { type: 'string', description: 'UI scene path' },
                operations: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            action: { type: 'string', enum: ['add_element', 'remove_element', 'modify_style', 'set_text'] },
                            element_type: { type: 'string' },
                            element_name: { type: 'string' },
                            property: { type: 'string' },
                            value: {},
                        },
                        required: ['action'],
                    },
                },
            },
            required: ['scene_path', 'operations'],
        },
        debug_runtime_error: {
            type: 'object',
            properties: {
                error_message: { type: 'string' },
                error_file: { type: 'string' },
                error_line: { type: 'integer' },
                stack_trace: { type: 'string' },
            },
            required: ['error_message', 'error_file', 'error_line'],
        },
        export_build: {
            type: 'object',
            properties: {
                platform: { type: 'string', enum: ['web', 'windows', 'linux', 'macos', 'android'], default: 'web' },
                optimize: { type: 'boolean', default: true },
            },
            required: ['platform'],
        },
        create_project_config: {
            type: 'object',
            properties: {
                project_name: { type: 'string', description: 'Name of the game project' },
                main_scene: { type: 'string', description: 'Path to the main scene, e.g. scenes/main.scene' },
                display_width: { type: 'integer', default: 1280 },
                display_height: { type: 'integer', default: 720 },
                game_mode: { type: 'string', enum: ['2d', '3d'], description: 'Whether this is a 2D or 3D game' },
            },
            required: ['project_name', 'main_scene', 'game_mode'],
        },
    };

    return schemas[toolName] || { type: 'object', properties: {} };
}

function getAnthropicTools(): AnthropicTool[] {
    return Object.values(TOOL_DEFINITIONS).map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: zodToJsonSchema(tool.name),
    }));
}

function getOpenAITools(): OpenAITool[] {
    return Object.values(TOOL_DEFINITIONS).map(tool => ({
        type: 'function' as const,
        function: {
            name: tool.name,
            description: tool.description,
            parameters: zodToJsonSchema(tool.name),
        },
    }));
}

// ── System Prompt ──────────────────────────────────────────────────

export type GameMode = '2d' | '3d';

// Tools available per mode
const TOOLS_2D = [
    'create_scene', 'write_game_logic', 'modify_scene', 'modify_physics',
    'search_free_asset', 'generate_sprite', 'generate_texture', 'generate_animation',
    'update_ui_layout', 'debug_runtime_error', 'export_build', 'create_project_config',
];

const TOOLS_3D = [
    'create_scene', 'write_game_logic', 'modify_scene', 'modify_physics',
    'search_free_asset', 'generate_sprite', 'generate_texture', 'generate_3d_model', 'generate_animation',
    'update_ui_layout', 'debug_runtime_error', 'export_build', 'create_project_config',
];

// Credit multiplier per mode
export const MODE_CREDIT_MULTIPLIER: Record<GameMode, number> = {
    '2d': 1,
    '3d': 3,
};

function buildSystemPrompt(fileList: string, conversationHistory: string, gameMode: GameMode): string {
    const is3D = gameMode === '3d';
    const modeLabel = is3D ? '3D' : '2D';

    const toolList2D = `- **create_scene**: Create new .scene files with specified root node types
- **write_game_logic**: Write AxiomScript (.axs) files — the scripting language is identical to GDScript
- **modify_scene**: Add/remove/modify nodes in existing scenes (add sprites, collisions, etc.)
- **modify_physics**: Configure physics bodies and collision shapes
- **search_free_asset**: 🆓 Search open-source libraries (OpenGameArt, Kenney, itch.io) for FREE assets — **0 credits**
- **generate_sprite**: AI-generate CUSTOM 2D sprite images — **5 credits**
- **generate_texture**: AI-generate CUSTOM textures — **5 credits**
- **generate_animation**: Create animation resources
- **update_ui_layout**: Modify UI scenes (menus, HUD, dialogs)
- **debug_runtime_error**: Analyze and fix runtime errors
- **export_build**: Queue a build for a target platform
- **create_project_config**: Create or update project.axiom (ALWAYS do this first for new games)`;

    const toolList3D = `- **create_scene**: Create new .scene files with specified root node types
- **write_game_logic**: Write AxiomScript (.axs) files — the scripting language is identical to GDScript
- **modify_scene**: Add/remove/modify nodes in existing scenes
- **modify_physics**: Configure physics bodies and collision shapes
- **search_free_asset**: 🆓 Search open-source libraries (OpenGameArt, Kenney, itch.io) for FREE assets — **0 credits**
- **generate_sprite**: AI-generate CUSTOM 2D sprite/texture images — **5 credits**
- **generate_texture**: AI-generate CUSTOM textures (PBR materials, terrain) — **5 credits**
- **generate_3d_model**: AI-generate 3D models (GLB format) using Meshy AI — **10 credits**
- **generate_animation**: Create animation resources
- **update_ui_layout**: Modify UI scenes (menus, HUD, dialogs)
- **debug_runtime_error**: Analyze and fix runtime errors
- **export_build**: Queue a build for a target platform
- **create_project_config**: Create or update project.axiom (ALWAYS do this first for new games)`;

    const mode3DExtra = is3D ? `

## 3D-Specific Patterns

### Node Types for 3D
- Use \`Entity3D\` (equivalent to Node3D) as root for 3D scenes
- Use \`MeshInstance3D\` for rendering 3D models
- Use \`Camera3D\` for the player camera
- Use \`DirectionalLight3D\`, \`OmniLight3D\`, \`SpotLight3D\` for lighting
- Use \`CharacterBody3D\` for player characters
- Use \`RigidBody3D\` for physics objects
- Use \`WorldEnvironment\` for skybox and post-processing

### 3D Movement Pattern
\`\`\`gdscript
extends CharacterBody3D

@export var speed: float = 5.0
@export var mouse_sensitivity: float = 0.002
var gravity = ProjectSettings.get_setting("physics/3d/default_gravity")

func _physics_process(delta):
    if not is_on_floor():
        velocity.y -= gravity * delta
    var input_dir = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
    var direction = (transform.basis * Vector3(input_dir.x, 0, input_dir.y)).normalized()
    velocity.x = direction.x * speed
    velocity.z = direction.z * speed
    move_and_slide()
\`\`\`

### Always include in 3D scenes:
1. A Camera3D node
2. At least one light (DirectionalLight3D)
3. A WorldEnvironment for atmosphere
4. Physics collision shapes for all solid objects` : '';

    return `You are the Axiom AI Agent — a powerful ${modeLabel} game development assistant embedded in the Axiom Engine, a proprietary browser-based game engine.

## Mode: ${modeLabel} Game Development
You are currently in **${modeLabel} mode**. ${is3D ? 'Focus on 3D game concepts: meshes, materials, cameras, lights, 3D physics.' : 'Focus on 2D game concepts: sprites, tilemaps, 2D physics, pixel art.'}

## Your Capabilities
You can CREATE complete ${modeLabel} games by using your tools. You don't just describe what to do — you EXECUTE actions by calling tools to modify the project directly.

## Available Actions
${is3D ? toolList3D : toolList2D}

## AxiomScript Reference
AxiomScript is identical to GDScript 4.x. Files use the .axs extension. Key patterns:

\`\`\`gdscript
extends ${is3D ? 'CharacterBody3D' : 'CharacterBody2D'}

@export var speed: float = ${is3D ? '5.0' : '200.0'}
${is3D ? '' : '@export var jump_force: float = -400.0\n'}
var gravity = ProjectSettings.get_setting("physics/${is3D ? '3d' : '2d'}/default_gravity")

func _physics_process(delta):
    if not is_on_floor():
        velocity.y ${is3D ? '-' : '+'}= gravity * delta
    ${is3D
            ? 'var input_dir = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")\n    var direction = (transform.basis * Vector3(input_dir.x, 0, input_dir.y)).normalized()\n    velocity.x = direction.x * speed\n    velocity.z = direction.z * speed'
            : 'if Input.is_action_just_pressed("ui_accept") and is_on_floor():\n        velocity.y = jump_force\n    var direction = Input.get_axis("ui_left", "ui_right")\n    velocity.x = direction * speed'
        }
    move_and_slide()
\`\`\`

## Scene Format
Scenes use Axiom's text-based scene format (.scene):
\`\`\`
[axiom_scene format=3]
[node name="Main" type="${is3D ? 'Entity3D' : 'Entity2D'}"]
[node name="Player" type="${is3D ? 'CharacterBody3D' : 'CharacterBody2D'}" parent="."]
script = ExtResource("scripts/player.axs")
${is3D ? '[node name="Camera" type="Camera3D" parent="."]\n[node name="Light" type="DirectionalLight3D" parent="."]' : '[node name="Sprite" type="Sprite2D" parent="Player"]'}
\`\`\`
${mode3DExtra}

## Current Project Files
${fileList || '(empty project — start fresh!)'}

## Recent Conversation
${conversationHistory || '(new conversation)'}

## Asset Strategy — IMPORTANT
When the user needs game assets (sprites, textures, tilesets, backgrounds, icons):
1. **FIRST** try \`search_free_asset\` to find free open-source assets. This costs 0 credits.
2. **ONLY** use \`generate_sprite\`/\`generate_texture\`/\`generate_3d_model\` if:
   - search_free_asset returned no suitable results
   - The user explicitly asks for AI-generated/custom art
   - The asset is too specific or unique to find in free libraries
3. When search_free_asset finds good results, download the best match and add it to the project.
4. Always tell the user the source and license of free assets you use.

## Rules
1. ALWAYS use tools to make changes. Never just describe changes without executing them.
2. When creating a NEW game, ALWAYS call create_project_config FIRST to generate project.axiom, then: scenes → scripts → assets → physics.
3. Use write_game_logic with the \`code_content\` parameter to write COMPLETE scripts (not just descriptions).
4. Be proactive — if the user asks for "an angry birds game", create ALL necessary files: project.axiom, main scene, player scripts, enemy scripts, UI, physics config.
5. After making changes, explain what you created and how to test it.
6. When writing scripts, write COMPLETE, FUNCTIONAL code. Do not use placeholder comments like "# TODO".
7. ${is3D ? 'Always use Entity3D/Node3D-based node types. Every 3D scene MUST have a Camera3D and at least one light.' : 'Always use Entity2D/Node2D-based node types for game objects.'}
8. Use the root node type "${is3D ? 'Entity3D' : 'Entity2D'}" by default when creating scenes.
9. Script files use the .axs extension (AxiomScript). The syntax is identical to GDScript 4.x.`;
}

// ── Orchestrator ───────────────────────────────────────────────────

export interface AgentResult {
    response: string;
    toolCalls: Array<{
        id: string;
        name: string;
        input: Record<string, unknown>;
        result: ToolResult;
    }>;
    totalTokens: number;
    iterations: number;
}

export async function runAgentLoop(params: {
    message: string;
    projectId: string;
    userId: string;
    supabase: SupabaseClient;
    conversationId: string;
    gameMode: GameMode;
    provider?: AgentProvider;
    onToolStart?: (toolName: string, input: Record<string, unknown>) => void;
    onToolResult?: (toolName: string, result: ToolResult) => void;
}): Promise<AgentResult> {
    const { message, projectId, userId, supabase, onToolStart, onToolResult, gameMode } = params;
    let provider: AgentProvider = params.provider ?? 'claude';

    // Resolve API key based on provider — auto-fallback to first available
    const apiKeyMap: Record<AgentProvider, string | undefined> = {
        claude: process.env.ANTHROPIC_API_KEY,
        gpt: process.env.OPENAI_API_KEY,
        kimi: process.env.MOONSHOT_API_KEY,
    };

    let apiKey = apiKeyMap[provider];

    // If requested provider has no key, try to fallback to one that does
    if (!apiKey) {
        const fallbackOrder: AgentProvider[] = ['kimi', 'claude', 'gpt'];
        const fallback = fallbackOrder.find(p => !!apiKeyMap[p]);
        if (fallback) {
            provider = fallback;
            apiKey = apiKeyMap[fallback];
        }
    }

    if (!apiKey) {
        const allProviders = Object.entries(PROVIDER_INFO)
            .map(([, info]) => info.label)
            .join(', ');
        return {
            response: `⚠️ No AI provider is configured. Add at least one API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, or MOONSHOT_API_KEY) to your environment variables. Available providers: ${allProviders}.`,
            toolCalls: [],
            totalTokens: 0,
            iterations: 0,
        };
    }

    // Fetch project files for context
    const { data: files } = await supabase
        .from('project_files')
        .select('path, content_type, size_bytes')
        .eq('project_id', projectId)
        .order('path');

    const fileList = (files ?? []).map(f => `  ${f.path} (${f.content_type}, ${f.size_bytes ?? 0}B)`).join('\n');

    // Fetch recent conversation history
    const { data: history } = await supabase
        .from('agent_logs')
        .select('role, content')
        .eq('conversation_id', params.conversationId)
        .order('created_at', { ascending: true })
        .limit(20);

    const conversationHistory = (history ?? [])
        .map(h => `${h.role}: ${(h.content as string).slice(0, 500)}`)
        .join('\n');

    // Build tools and system prompt — filtered by mode
    const allowedTools = gameMode === '3d' ? TOOLS_3D : TOOLS_2D;
    const systemPrompt = buildSystemPrompt(fileList, conversationHistory, gameMode);

    // ReAct Loop — 3D gets more iterations since scenes are more complex
    const MAX_ITERATIONS = gameMode === '3d' ? 15 : 10;
    const allToolCalls: AgentResult['toolCalls'] = [];
    let totalTokens = 0;
    let iterations = 0;

    const toolCtx = { supabase, projectId, userId };

    // ── Route to provider-specific loop ────────────────────────────
    if (provider === 'claude') {
        return runClaudeLoop({
            apiKey, systemPrompt, message, allowedTools, MAX_ITERATIONS,
            allToolCalls, totalTokens, iterations, toolCtx, onToolStart, onToolResult,
        });
    } else {
        // GPT and Kimi K2.5 both use OpenAI-compatible format
        const baseUrl = provider === 'kimi'
            ? 'https://api.moonshot.ai/v1'
            : 'https://api.openai.com/v1';
        const model = PROVIDER_INFO[provider].model;

        return runOpenAICompatibleLoop({
            apiKey, baseUrl, model, systemPrompt, message, allowedTools,
            MAX_ITERATIONS, allToolCalls, totalTokens, iterations, toolCtx,
            onToolStart, onToolResult,
        });
    }
}

// ── Claude (Anthropic) ReAct Loop ──────────────────────────────────

async function runClaudeLoop(params: {
    apiKey: string;
    systemPrompt: string;
    message: string;
    allowedTools: string[];
    MAX_ITERATIONS: number;
    allToolCalls: AgentResult['toolCalls'];
    totalTokens: number;
    iterations: number;
    toolCtx: { supabase: SupabaseClient; projectId: string; userId: string };
    onToolStart?: (toolName: string, input: Record<string, unknown>) => void;
    onToolResult?: (toolName: string, result: ToolResult) => void;
}): Promise<AgentResult> {
    const { apiKey, systemPrompt, allowedTools, toolCtx, onToolStart, onToolResult } = params;
    const tools = getAnthropicTools().filter(t => allowedTools.includes(t.name));
    let { totalTokens, iterations } = params;
    const allToolCalls = params.allToolCalls;

    const messages: AnthropicMessage[] = [
        { role: 'user', content: params.message },
    ];

    for (let i = 0; i < params.MAX_ITERATIONS; i++) {
        iterations = i + 1;

        const response = await callClaude(apiKey, systemPrompt, messages, tools);
        totalTokens += response.usage.input_tokens + response.usage.output_tokens;

        const assistantBlocks = response.content;
        messages.push({ role: 'assistant', content: assistantBlocks });

        if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
            const textBlocks = assistantBlocks.filter(b => b.type === 'text') as Array<{ type: 'text'; text: string }>;
            return {
                response: textBlocks.map(b => b.text).join('\n'),
                toolCalls: allToolCalls,
                totalTokens,
                iterations,
            };
        }

        if (response.stop_reason === 'tool_use') {
            const toolUseBlocks = assistantBlocks.filter(b => b.type === 'tool_use') as Array<{
                type: 'tool_use'; id: string; name: string; input: Record<string, unknown>;
            }>;

            const toolResults: AnthropicBlock[] = [];

            for (const toolUse of toolUseBlocks) {
                onToolStart?.(toolUse.name, toolUse.input);
                const result = await dispatchTool(toolUse.name, toolUse.input, toolCtx);
                result.callId = toolUse.id;
                onToolResult?.(toolUse.name, result);

                allToolCalls.push({ id: toolUse.id, name: toolUse.name, input: toolUse.input, result });
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: JSON.stringify(result.output),
                    is_error: !result.success,
                });
            }

            messages.push({ role: 'user', content: toolResults });
        }
    }

    const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
    let finalText = 'Agent reached maximum iterations.';
    if (lastAssistant && Array.isArray(lastAssistant.content)) {
        const textBlocks = (lastAssistant.content as AnthropicBlock[]).filter(b => b.type === 'text') as Array<{ type: 'text'; text: string }>;
        if (textBlocks.length > 0) finalText = textBlocks.map(b => b.text).join('\n');
    }

    return { response: finalText, toolCalls: allToolCalls, totalTokens, iterations };
}

// ── OpenAI-Compatible ReAct Loop (GPT & Kimi K2.5) ────────────────

async function runOpenAICompatibleLoop(params: {
    apiKey: string;
    baseUrl: string;
    model: string;
    systemPrompt: string;
    message: string;
    allowedTools: string[];
    MAX_ITERATIONS: number;
    allToolCalls: AgentResult['toolCalls'];
    totalTokens: number;
    iterations: number;
    toolCtx: { supabase: SupabaseClient; projectId: string; userId: string };
    onToolStart?: (toolName: string, input: Record<string, unknown>) => void;
    onToolResult?: (toolName: string, result: ToolResult) => void;
}): Promise<AgentResult> {
    const { apiKey, baseUrl, model, systemPrompt, allowedTools, toolCtx, onToolStart, onToolResult } = params;
    const tools = getOpenAITools().filter(t => allowedTools.includes(t.function.name));
    let { totalTokens, iterations } = params;
    const allToolCalls = params.allToolCalls;

    const messages: OpenAIMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: params.message },
    ];

    for (let i = 0; i < params.MAX_ITERATIONS; i++) {
        iterations = i + 1;

        const response = await callOpenAICompatible(apiKey, baseUrl, model, messages, tools);
        totalTokens += response.usage.prompt_tokens + response.usage.completion_tokens;

        const choice = response.choices[0];
        if (!choice) break;

        // Kimi K2.5 may return content in reasoning_content instead of content
        const messageContent = choice.message.content || choice.message.reasoning_content || null;

        // Add assistant message to conversation
        messages.push({
            role: 'assistant',
            content: messageContent,
            tool_calls: choice.message.tool_calls,
        });

        // If no tool calls, we're done
        if (choice.finish_reason === 'stop' || choice.finish_reason === 'length' || !choice.message.tool_calls?.length) {
            return {
                response: messageContent ?? 'No response.',
                toolCalls: allToolCalls,
                totalTokens,
                iterations,
            };
        }

        // Execute tool calls
        for (const tc of choice.message.tool_calls) {
            const toolName = tc.function.name;
            let toolInput: Record<string, unknown> = {};
            try { toolInput = JSON.parse(tc.function.arguments); } catch { /* empty */ }

            onToolStart?.(toolName, toolInput);
            const result = await dispatchTool(toolName, toolInput, toolCtx);
            result.callId = tc.id;
            onToolResult?.(toolName, result);

            allToolCalls.push({ id: tc.id, name: toolName, input: toolInput, result });

            // Add tool result message
            messages.push({
                role: 'tool',
                content: JSON.stringify(result.output),
                tool_call_id: tc.id,
            });
        }
    }

    // Max iterations reached
    const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
    return {
        response: lastAssistant?.content ?? 'Agent reached maximum iterations.',
        toolCalls: allToolCalls,
        totalTokens,
        iterations,
    };
}

// ── Claude API Call ────────────────────────────────────────────────

async function callClaude(
    apiKey: string,
    system: string,
    messages: AnthropicMessage[],
    tools: AnthropicTool[],
): Promise<AnthropicResponse> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4096,
            system,
            messages,
            tools,
        }),
    });

    if (!res.ok) {
        const error = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(`Claude API error: ${error?.error?.message || res.statusText}`);
    }

    return res.json() as Promise<AnthropicResponse>;
}

// ── OpenAI-Compatible API Call (GPT & Kimi K2.5 via Moonshot) ──────

async function callOpenAICompatible(
    apiKey: string,
    baseUrl: string,
    model: string,
    messages: OpenAIMessage[],
    tools: OpenAITool[],
): Promise<OpenAIResponse> {
    // Kimi K2.5 supports tools but needs clean message format
    const cleanMessages = messages.map(m => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content ?? '' };
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        return msg;
    });

    const body: Record<string, unknown> = {
        model,
        max_tokens: 4096,
        messages: cleanMessages,
    };

    // Only include tools if available
    if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        let errorMsg = res.statusText;
        try {
            const errorJson = JSON.parse(errorText) as { error?: { message?: string } };
            errorMsg = errorJson?.error?.message || errorMsg;
        } catch { /* use statusText */ }
        throw new Error(`${model} API error (${res.status}): ${errorMsg}`);
    }

    return res.json() as Promise<OpenAIResponse>;
}
