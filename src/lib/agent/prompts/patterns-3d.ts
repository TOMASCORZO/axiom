/**
 * 3D Game Patterns — comprehensive patterns for common 3D game types.
 */

export function get3DPatterns(): string {
    return `## 3D Game Patterns

### Node Types for 3D
- \`Entity3D\` (equivalent to Node3D) as root for 3D scenes
- \`MeshInstance3D\` for rendering 3D models
- \`Camera3D\` for the player camera
- \`DirectionalLight3D\`, \`OmniLight3D\`, \`SpotLight3D\` for lighting
- \`CharacterBody3D\` for player characters
- \`RigidBody3D\` for physics objects
- \`WorldEnvironment\` for skybox and post-processing

### Always include in 3D scenes:
1. A Camera3D node
2. At least one light (DirectionalLight3D)
3. A WorldEnvironment for atmosphere
4. Physics collision shapes for all solid objects

### First-Person Character Controller
\`\`\`gdscript
extends CharacterBody3D

@export var speed: float = 5.0
@export var sprint_speed: float = 8.0
@export var jump_force: float = 4.5
@export var mouse_sensitivity: float = 0.002
@export var fov_normal: float = 75.0
@export var fov_sprint: float = 85.0

var gravity = ProjectSettings.get_setting("physics/3d/default_gravity")
@onready var head = $Head
@onready var camera = $Head/Camera3D

func _ready():
    Input.mouse_mode = Input.MOUSE_MODE_CAPTURED

func _unhandled_input(event):
    if event is InputEventMouseMotion:
        rotate_y(-event.relative.x * mouse_sensitivity)
        head.rotate_x(-event.relative.y * mouse_sensitivity)
        head.rotation.x = clamp(head.rotation.x, -PI/2, PI/2)
    if event.is_action_pressed("ui_cancel"):
        Input.mouse_mode = Input.MOUSE_MODE_VISIBLE

func _physics_process(delta):
    if not is_on_floor():
        velocity.y -= gravity * delta

    if Input.is_action_just_pressed("jump") and is_on_floor():
        velocity.y = jump_force

    var is_sprinting = Input.is_action_pressed("sprint")
    var current_speed = sprint_speed if is_sprinting else speed

    var input_dir = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
    var direction = (transform.basis * Vector3(input_dir.x, 0, input_dir.y)).normalized()

    if direction:
        velocity.x = direction.x * current_speed
        velocity.z = direction.z * current_speed
    else:
        velocity.x = move_toward(velocity.x, 0, current_speed)
        velocity.z = move_toward(velocity.z, 0, current_speed)

    # FOV lerp for sprint feel
    camera.fov = lerp(camera.fov, fov_sprint if is_sprinting else fov_normal, delta * 8.0)

    move_and_slide()
\`\`\`

### Third-Person Character Controller
\`\`\`gdscript
extends CharacterBody3D

@export var speed: float = 5.0
@export var rotation_speed: float = 10.0
@export var jump_force: float = 4.5
@export var camera_distance: float = 5.0

var gravity = ProjectSettings.get_setting("physics/3d/default_gravity")
@onready var camera_pivot = $CameraPivot
@onready var camera = $CameraPivot/SpringArm3D/Camera3D
@onready var model = $Model

func _physics_process(delta):
    if not is_on_floor():
        velocity.y -= gravity * delta

    if Input.is_action_just_pressed("jump") and is_on_floor():
        velocity.y = jump_force

    var input_dir = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
    var direction = Vector3.ZERO

    if input_dir != Vector2.ZERO:
        var camera_basis = camera.global_transform.basis
        direction = (camera_basis * Vector3(input_dir.x, 0, input_dir.y)).normalized()
        direction.y = 0
        direction = direction.normalized()

        # Rotate model to face movement direction
        var target_angle = atan2(direction.x, direction.z)
        model.rotation.y = lerp_angle(model.rotation.y, target_angle, rotation_speed * delta)

    velocity.x = direction.x * speed
    velocity.z = direction.z * speed

    move_and_slide()
\`\`\`

### 3D Camera Orbit
\`\`\`gdscript
extends Node3D

@export var target_path: NodePath
@export var distance: float = 5.0
@export var min_distance: float = 2.0
@export var max_distance: float = 15.0
@export var mouse_sensitivity: float = 0.003
@export var min_pitch: float = -80.0
@export var max_pitch: float = 60.0

var yaw: float = 0.0
var pitch: float = -30.0
var target: Node3D

func _ready():
    target = get_node(target_path)
    Input.mouse_mode = Input.MOUSE_MODE_CAPTURED

func _unhandled_input(event):
    if event is InputEventMouseMotion:
        yaw -= event.relative.x * mouse_sensitivity
        pitch -= event.relative.y * mouse_sensitivity
        pitch = clamp(pitch, deg_to_rad(min_pitch), deg_to_rad(max_pitch))
    if event is InputEventMouseButton:
        if event.button_index == MOUSE_BUTTON_WHEEL_UP:
            distance = max(min_distance, distance - 0.5)
        elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
            distance = min(max_distance, distance + 0.5)

func _process(delta):
    if not target:
        return
    var offset = Vector3.ZERO
    offset.x = distance * cos(pitch) * sin(yaw)
    offset.y = distance * sin(-pitch)
    offset.z = distance * cos(pitch) * cos(yaw)

    global_position = global_position.lerp(target.global_position + offset, 10 * delta)
    look_at(target.global_position)
\`\`\`

### 3D Projectile / Raycast Shooting
\`\`\`gdscript
extends Node3D

@export var damage: int = 25
@export var fire_rate: float = 0.1
@export var max_range: float = 100.0

var can_fire: bool = true
@onready var raycast = $RayCast3D
@onready var muzzle_flash = $MuzzleFlash

func _input(event):
    if event.is_action_pressed("shoot") and can_fire:
        shoot()

func shoot():
    can_fire = false
    muzzle_flash.visible = true

    if raycast.is_colliding():
        var target = raycast.get_collider()
        var hit_point = raycast.get_collision_point()
        if target.has_method("take_damage"):
            target.take_damage(damage)

    await get_tree().create_timer(0.05).timeout
    muzzle_flash.visible = false
    await get_tree().create_timer(fire_rate).timeout
    can_fire = true
\`\`\`

### Simple 3D Environment Setup
\`\`\`gdscript
# Typical 3D scene structure:
# Entity3D (root)
#   WorldEnvironment
#     - environment resource with sky, ambient light, fog
#   DirectionalLight3D
#     - shadow_enabled = true
#     - rotation = Vector3(-45, -45, 0) degrees
#   Camera3D
#   StaticBody3D (floor)
#     MeshInstance3D (PlaneMesh, size 100x100)
#     CollisionShape3D (WorldBoundaryShape3D)
#   Player (CharacterBody3D)
#     MeshInstance3D (CapsuleMesh)
#     CollisionShape3D (CapsuleShape3D)
\`\`\`

### 3D Enemy with Navigation
\`\`\`gdscript
extends CharacterBody3D

@export var speed: float = 3.0
@export var attack_range: float = 2.0
@export var chase_range: float = 15.0
@export var damage: int = 10

var gravity = ProjectSettings.get_setting("physics/3d/default_gravity")
var player: Node3D = null
@onready var nav_agent = $NavigationAgent3D

func _ready():
    player = get_tree().get_first_node_in_group("player")
    nav_agent.path_desired_distance = 0.5
    nav_agent.target_desired_distance = attack_range

func _physics_process(delta):
    velocity.y -= gravity * delta

    if player and global_position.distance_to(player.global_position) < chase_range:
        nav_agent.target_position = player.global_position
        var next_pos = nav_agent.get_next_path_position()
        var direction = (next_pos - global_position).normalized()
        direction.y = 0
        velocity.x = direction.x * speed
        velocity.z = direction.z * speed

        # Face movement direction
        if direction.length() > 0.1:
            look_at(global_position + direction)

        if global_position.distance_to(player.global_position) < attack_range:
            if player.has_method("take_damage"):
                player.take_damage(damage)

    move_and_slide()
\`\`\``;
}
