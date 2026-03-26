/**
 * Godogen Skills — mandatory multi-step pipelines for game generation.
 *
 * Every user gets these skills automatically. They are NOT optional.
 * Skills produce COMPLETE, RUNNABLE game files — not stubs or skeletons.
 * The LLM enhances them with context, but the pipeline guarantees a
 * minimum viable game that renders in the engine preview.
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
    /** Whether the skill must execute ALL steps before the LLM continues. */
    mandatory: boolean;
    steps: (params: SkillParams) => SkillStep[];
}

export interface SkillParams {
    gameName: string;
    gameDescription: string;
    gameMode: GameMode;
    scenes?: string[];
    scripts?: string[];
}

// ═══════════════════════════════════════════════════════════════════
// SKILL: GENERATE_GAME — Full game pipeline (2D)
// ═══════════════════════════════════════════════════════════════════

export const GENERATE_GAME: Skill = {
    name: 'generate_game',
    description: 'Generate a complete, playable game from a description',
    mandatory: true,
    steps: (params) => {
        const { gameName, gameDescription, gameMode } = params;
        const is3D = gameMode === '3d';

        if (is3D) return generate3DGame(gameName, gameDescription);
        return generate2DGame(gameName, gameDescription);
    },
};

function generate2DGame(gameName: string, description: string): SkillStep[] {
    return [
        // Step 1: Project config with complete input bindings
        {
            tool: 'create_project_config',
            input: {
                project_name: gameName,
                main_scene: 'scenes/main.scene',
                display_width: 1280,
                display_height: 720,
                game_mode: '2d',
            },
            description: `Create project config for "${gameName}"`,
        },
        // Step 2: Main scene with player + camera
        {
            tool: 'create_scene',
            input: {
                scene_name: 'Main',
                root_node_type: 'Entity2D',
                target_path: 'scenes/main.scene',
            },
            description: 'Create main scene',
        },
        // Step 3: Player controller with COMPLETE code
        {
            tool: 'write_game_logic',
            input: {
                file_path: 'scripts/player.axs',
                description: `Player controller for ${gameName}: ${description}`,
                extends_type: 'CharacterBody2D',
                code_content: `extends CharacterBody2D

@export var speed: float = 200.0
@export var jump_force: float = -400.0

var gravity = ProjectSettings.get_setting("physics/2d/default_gravity")
var facing_right: bool = true

func _ready():
\tadd_to_group("player")

func _physics_process(delta):
\t# Gravity
\tif not is_on_floor():
\t\tvelocity.y += gravity * delta

\t# Jump
\tif Input.is_action_just_pressed("jump") and is_on_floor():
\t\tvelocity.y = jump_force

\t# Movement
\tvar direction = Input.get_axis("ui_left", "ui_right")
\tvelocity.x = move_toward(velocity.x, direction * speed, speed * 10 * delta)

\t# Flip sprite direction
\tif direction != 0:
\t\tfacing_right = direction > 0

\tmove_and_slide()
`,
            },
            description: 'Write player controller script',
        },
        // Step 4: Wire player into scene + add camera + ground
        {
            tool: 'modify_scene',
            input: {
                scene_path: 'scenes/main.scene',
                operations: [
                    {
                        action: 'add_node',
                        node_name: 'Player',
                        node_type: 'CharacterBody2D',
                        target_node: '.',
                        script_path: 'scripts/player.axs',
                    },
                    {
                        action: 'add_node',
                        node_name: 'CollisionShape2D',
                        node_type: 'CollisionShape2D',
                        target_node: 'Player',
                    },
                    {
                        action: 'add_node',
                        node_name: 'Camera2D',
                        node_type: 'Camera2D',
                        target_node: 'Player',
                    },
                    {
                        action: 'add_node',
                        node_name: 'Ground',
                        node_type: 'StaticBody2D',
                        target_node: '.',
                    },
                    {
                        action: 'add_node',
                        node_name: 'GroundCollision',
                        node_type: 'CollisionShape2D',
                        target_node: 'Ground',
                    },
                ],
            },
            description: 'Wire player, camera, and ground into main scene',
        },
        // Step 5: Game manager script for basic game state
        {
            tool: 'write_game_logic',
            input: {
                file_path: 'scripts/game_manager.axs',
                description: `Game manager for ${gameName}`,
                extends_type: 'Entity2D',
                code_content: `extends Node2D

var score: int = 0
var is_game_over: bool = false

func _ready():
\tprint("${gameName} started!")

func add_score(amount: int):
\tscore += amount
\tprint("Score: ", score)

func game_over():
\tis_game_over = true
\tprint("Game Over! Final score: ", score)

func restart():
\tscore = 0
\tis_game_over = false
\tget_tree().reload_current_scene()

func _input(event):
\tif event.is_action_pressed("ui_accept") and is_game_over:
\t\trestart()
`,
            },
            description: 'Write game manager script',
        },
    ];
}

function generate3DGame(gameName: string, description: string): SkillStep[] {
    return [
        // Step 1: Project config
        {
            tool: 'create_project_config',
            input: {
                project_name: gameName,
                main_scene: 'scenes/main.scene',
                display_width: 1280,
                display_height: 720,
                game_mode: '3d',
            },
            description: `Create 3D project config for "${gameName}"`,
        },
        // Step 2: Main scene
        {
            tool: 'create_scene',
            input: {
                scene_name: 'Main',
                root_node_type: 'Entity3D',
                target_path: 'scenes/main.scene',
            },
            description: 'Create main 3D scene',
        },
        // Step 3: Player controller with FPS camera
        {
            tool: 'write_game_logic',
            input: {
                file_path: 'scripts/player.axs',
                description: `3D player controller for ${gameName}: ${description}`,
                extends_type: 'CharacterBody3D',
                code_content: `extends CharacterBody3D

@export var speed: float = 5.0
@export var jump_force: float = 4.5
@export var mouse_sensitivity: float = 0.002
@export var sprint_multiplier: float = 1.5

var gravity = ProjectSettings.get_setting("physics/3d/default_gravity")
var head: Node3D

func _ready():
\thead = $Head
\tInput.mouse_mode = Input.MOUSE_MODE_CAPTURED
\tadd_to_group("player")

func _unhandled_input(event):
\tif event is InputEventMouseMotion:
\t\trotate_y(-event.relative.x * mouse_sensitivity)
\t\thead.rotate_x(-event.relative.y * mouse_sensitivity)
\t\thead.rotation.x = clamp(head.rotation.x, -PI / 2, PI / 2)
\tif event.is_action_pressed("ui_cancel"):
\t\tInput.mouse_mode = Input.MOUSE_MODE_VISIBLE

func _physics_process(delta):
\tif not is_on_floor():
\t\tvelocity.y -= gravity * delta

\tif Input.is_action_just_pressed("jump") and is_on_floor():
\t\tvelocity.y = jump_force

\tvar input_dir = Input.get_vector("move_left", "move_right", "move_forward", "move_back")
\tvar direction = (transform.basis * Vector3(input_dir.x, 0, input_dir.y)).normalized()

\tvar current_speed = speed
\tif Input.is_action_pressed("sprint"):
\t\tcurrent_speed *= sprint_multiplier

\tif direction:
\t\tvelocity.x = direction.x * current_speed
\t\tvelocity.z = direction.z * current_speed
\telse:
\t\tvelocity.x = move_toward(velocity.x, 0, current_speed)
\t\tvelocity.z = move_toward(velocity.z, 0, current_speed)

\tmove_and_slide()
`,
            },
            description: 'Write 3D player controller with FPS camera',
        },
        // Step 4: Wire player, camera, lights, floor
        {
            tool: 'modify_scene',
            input: {
                scene_path: 'scenes/main.scene',
                operations: [
                    {
                        action: 'add_node',
                        node_name: 'Player',
                        node_type: 'CharacterBody3D',
                        target_node: '.',
                        script_path: 'scripts/player.axs',
                    },
                    {
                        action: 'add_node',
                        node_name: 'CollisionShape3D',
                        node_type: 'CollisionShape3D',
                        target_node: 'Player',
                    },
                    {
                        action: 'add_node',
                        node_name: 'Head',
                        node_type: 'Node3D',
                        target_node: 'Player',
                    },
                    {
                        action: 'add_node',
                        node_name: 'Camera3D',
                        node_type: 'Camera3D',
                        target_node: 'Player/Head',
                    },
                    {
                        action: 'add_node',
                        node_name: 'MeshInstance3D',
                        node_type: 'MeshInstance3D',
                        target_node: 'Player',
                    },
                    {
                        action: 'add_node',
                        node_name: 'DirectionalLight3D',
                        node_type: 'DirectionalLight3D',
                        target_node: '.',
                    },
                    {
                        action: 'add_node',
                        node_name: 'Floor',
                        node_type: 'StaticBody3D',
                        target_node: '.',
                    },
                    {
                        action: 'add_node',
                        node_name: 'FloorMesh',
                        node_type: 'MeshInstance3D',
                        target_node: 'Floor',
                    },
                    {
                        action: 'add_node',
                        node_name: 'FloorCollision',
                        node_type: 'CollisionShape3D',
                        target_node: 'Floor',
                    },
                    {
                        action: 'add_node',
                        node_name: 'WorldEnvironment',
                        node_type: 'WorldEnvironment',
                        target_node: '.',
                    },
                ],
            },
            description: 'Wire player, camera, lights, floor into 3D scene',
        },
        // Step 5: Game manager
        {
            tool: 'write_game_logic',
            input: {
                file_path: 'scripts/game_manager.axs',
                description: `3D game manager for ${gameName}`,
                extends_type: 'Entity3D',
                code_content: `extends Node3D

var score: int = 0
var is_game_over: bool = false

func _ready():
\tprint("${gameName} started!")

func add_score(amount: int):
\tscore += amount
\tprint("Score: ", score)

func game_over():
\tis_game_over = true
\tprint("Game Over! Final score: ", score)
\tInput.mouse_mode = Input.MOUSE_MODE_VISIBLE

func restart():
\tscore = 0
\tis_game_over = false
\tget_tree().reload_current_scene()
`,
            },
            description: 'Write 3D game manager script',
        },
    ];
}

// ═══════════════════════════════════════════════════════════════════
// SKILL: GENERATE_PLATFORMER — Complete platformer with enemies
// ═══════════════════════════════════════════════════════════════════

export const GENERATE_PLATFORMER: Skill = {
    name: 'generate_platformer',
    description: 'Generate a complete 2D platformer with player, enemies, and collectibles',
    mandatory: true,
    steps: (params) => {
        const { gameName } = params;
        return [
            ...generate2DGame(gameName, 'platformer game'),
            // Extra: enemy script
            {
                tool: 'write_game_logic',
                input: {
                    file_path: 'scripts/enemy.axs',
                    description: 'Simple patrol enemy',
                    extends_type: 'CharacterBody2D',
                    code_content: `extends CharacterBody2D

@export var speed: float = 80.0
@export var damage: int = 1

var gravity = ProjectSettings.get_setting("physics/2d/default_gravity")
var direction: float = 1.0

func _physics_process(delta):
\tvelocity.y += gravity * delta

\tif is_on_wall():
\t\tdirection *= -1

\tvelocity.x = direction * speed
\tmove_and_slide()

func _on_body_entered(body):
\tif body.is_in_group("player") and body.has_method("take_damage"):
\t\tbody.take_damage(damage)
`,
                },
                description: 'Write enemy patrol script',
            },
            // Extra: collectible script
            {
                tool: 'write_game_logic',
                input: {
                    file_path: 'scripts/collectible.axs',
                    description: 'Collectible coin/item',
                    extends_type: 'Area2D',
                    code_content: `extends Area2D

@export var value: int = 1

func _on_body_entered(body):
\tif body.is_in_group("player"):
\t\tvar manager = get_tree().get_first_node_in_group("game_manager")
\t\tif manager and manager.has_method("add_score"):
\t\t\tmanager.add_score(value)
\t\tvar tween = create_tween()
\t\ttween.tween_property(self, "scale", Vector2(1.5, 1.5), 0.1)
\t\ttween.tween_property(self, "modulate:a", 0.0, 0.15)
\t\ttween.tween_callback(queue_free)
`,
                },
                description: 'Write collectible script',
            },
            // Wire extras into scene
            {
                tool: 'modify_scene',
                input: {
                    scene_path: 'scenes/main.scene',
                    operations: [
                        {
                            action: 'add_node',
                            node_name: 'Enemies',
                            node_type: 'Node2D',
                            target_node: '.',
                        },
                        {
                            action: 'add_node',
                            node_name: 'Collectibles',
                            node_type: 'Node2D',
                            target_node: '.',
                        },
                    ],
                },
                description: 'Add enemy and collectible containers to scene',
            },
        ];
    },
};

// ═══════════════════════════════════════════════════════════════════
// SKILL: GENERATE_TOP_DOWN — Complete top-down game (RPG/action)
// ═══════════════════════════════════════════════════════════════════

export const GENERATE_TOP_DOWN: Skill = {
    name: 'generate_top_down',
    description: 'Generate a complete top-down 2D game (RPG/action style)',
    mandatory: true,
    steps: (params) => {
        const { gameName } = params;
        return [
            {
                tool: 'create_project_config',
                input: {
                    project_name: gameName,
                    main_scene: 'scenes/main.scene',
                    display_width: 1280,
                    display_height: 720,
                    game_mode: '2d',
                },
                description: `Create project config for "${gameName}"`,
            },
            {
                tool: 'create_scene',
                input: {
                    scene_name: 'Main',
                    root_node_type: 'Entity2D',
                    target_path: 'scenes/main.scene',
                },
                description: 'Create main scene',
            },
            {
                tool: 'write_game_logic',
                input: {
                    file_path: 'scripts/player.axs',
                    description: 'Top-down player with 8-directional movement',
                    extends_type: 'CharacterBody2D',
                    code_content: `extends CharacterBody2D

@export var speed: float = 150.0
@export var friction: float = 0.2
@export var acceleration: float = 0.3

func _ready():
\tadd_to_group("player")

func _physics_process(delta):
\tvar input_vector = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")

\tif input_vector != Vector2.ZERO:
\t\tvelocity = velocity.lerp(input_vector.normalized() * speed, acceleration)
\telse:
\t\tvelocity = velocity.lerp(Vector2.ZERO, friction)

\tmove_and_slide()
`,
                },
                description: 'Write top-down player controller',
            },
            {
                tool: 'modify_scene',
                input: {
                    scene_path: 'scenes/main.scene',
                    operations: [
                        {
                            action: 'add_node',
                            node_name: 'Player',
                            node_type: 'CharacterBody2D',
                            target_node: '.',
                            script_path: 'scripts/player.axs',
                        },
                        {
                            action: 'add_node',
                            node_name: 'CollisionShape2D',
                            node_type: 'CollisionShape2D',
                            target_node: 'Player',
                        },
                        {
                            action: 'add_node',
                            node_name: 'Camera2D',
                            node_type: 'Camera2D',
                            target_node: 'Player',
                        },
                    ],
                },
                description: 'Wire player and camera into scene',
            },
        ];
    },
};

// ═══════════════════════════════════════════════════════════════════
// SKILL: FIX_ERROR — Diagnostic pipeline
// ═══════════════════════════════════════════════════════════════════

export const FIX_ERROR: Skill = {
    name: 'fix_error',
    description: 'Diagnose and fix a runtime error',
    mandatory: false,
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

// ═══════════════════════════════════════════════════════════════════
// SKILL: ADD_FEATURE — Enhancement pipeline
// ═══════════════════════════════════════════════════════════════════

export const ADD_FEATURE: Skill = {
    name: 'add_feature',
    description: 'Add a new feature or system to an existing game',
    mandatory: false,
    steps: (params) => {
        return [
            {
                tool: 'write_game_logic',
                input: {
                    file_path: `scripts/${params.gameName.toLowerCase().replace(/\s+/g, '_')}_feature.axs`,
                    description: params.gameDescription,
                    extends_type: params.gameMode === '3d' ? 'Entity3D' : 'Entity2D',
                },
                description: `Write script for: ${params.gameDescription}`,
            },
        ];
    },
};

// ═══════════════════════════════════════════════════════════════════
// SKILL: IMPROVE_GAME — Polish and enhance an existing game
// ═══════════════════════════════════════════════════════════════════

export const IMPROVE_GAME: Skill = {
    name: 'improve_game',
    description: 'Improve an existing game with better mechanics, UI, or polish',
    mandatory: false,
    steps: () => {
        return [
            {
                tool: 'list_files',
                input: { pattern: '**/*.{scene,axs}' },
                description: 'List all game files to understand current state',
            },
        ];
    },
};

// ═══════════════════════════════════════════════════════════════════
// REGISTRY — All skills available to every user
// ═══════════════════════════════════════════════════════════════════

export const ALL_SKILLS: Record<string, Skill> = {
    generate_game: GENERATE_GAME,
    generate_platformer: GENERATE_PLATFORMER,
    generate_top_down: GENERATE_TOP_DOWN,
    fix_error: FIX_ERROR,
    add_feature: ADD_FEATURE,
    improve_game: IMPROVE_GAME,
};

// ═══════════════════════════════════════════════════════════════════
// DETECTION — Match user intent to the right skill
// ═══════════════════════════════════════════════════════════════════

/**
 * Detect which skill (if any) matches the user's message.
 * Returns null if no skill matches — agent uses normal ReAct loop.
 *
 * Skills are mandatory: if detected, ALL steps execute before the LLM
 * continues with its own reasoning.
 */
export function detectSkill(message: string): { skill: Skill; params: Partial<SkillParams> } | null {
    const lower = message.toLowerCase();

    // Extract game name from quotes or "called/named" pattern
    const nameMatch = message.match(/(?:called|named|llamado|titulado)\s+["']?([^"'\n,]+)["']?/i)
        || message.match(/["']([^"']+)["']/);
    const gameName = nameMatch?.[1]?.trim() || 'My Game';

    // ── Specific game types (matched FIRST for precision) ──

    // Platformer detection
    if (/(?:make|create|build|generate|haz|crea|hacer)\s+/i.test(lower)
        && /(?:platformer|plataformer|plataforma|side.?scroller|jump.?and.?run)/i.test(lower)) {
        return {
            skill: GENERATE_PLATFORMER,
            params: { gameName, gameDescription: message },
        };
    }

    // Top-down / RPG detection
    if (/(?:make|create|build|generate|haz|crea|hacer)\s+/i.test(lower)
        && /(?:top.?down|rpg|zelda|roguelike|dungeon.?crawler|vista.?superior)/i.test(lower)) {
        return {
            skill: GENERATE_TOP_DOWN,
            params: { gameName, gameDescription: message },
        };
    }

    // ── General game creation (catch-all) ──

    if (/(?:make|create|build|generate|haz|crea|hacer)\s+(?:a |an |un |una |me )?\s*(?:game|juego|proyecto|videogame|videojuego)/i.test(lower)) {
        return {
            skill: GENERATE_GAME,
            params: { gameName, gameDescription: message },
        };
    }

    // ── Improvement / polish ──

    if (/(?:improve|polish|enhance|better|mejorar|pulir)\s+/i.test(lower)
        && /(?:game|juego|project|proyecto)/i.test(lower)) {
        return {
            skill: IMPROVE_GAME,
            params: { gameName, gameDescription: message },
        };
    }

    // ── Error fixing ──

    if (/(?:fix|solve|debug|error|bug|crash|arregla|soluciona)/i.test(lower)) {
        return {
            skill: FIX_ERROR,
            params: { gameDescription: message },
        };
    }

    // ── Add feature ──

    if (/(?:add|implement|agrega|añade)\s+(?:a |an |un |una )?/i.test(lower)
        && /(?:feature|system|mechanic|función|sistema|mecánica|component|componente)/i.test(lower)) {
        return {
            skill: ADD_FEATURE,
            params: { gameName, gameDescription: message },
        };
    }

    return null;
}
