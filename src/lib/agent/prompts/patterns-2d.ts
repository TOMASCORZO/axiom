/**
 * 2D Game Patterns — comprehensive patterns for common 2D game types.
 */

export function get2DPatterns(): string {
    return `## 2D Game Patterns

### Platformer Character Controller
\`\`\`gdscript
extends CharacterBody2D

@export var speed: float = 200.0
@export var jump_force: float = -400.0
@export var dash_speed: float = 500.0
@export var coyote_time: float = 0.15
@export var jump_buffer_time: float = 0.1

var gravity = ProjectSettings.get_setting("physics/2d/default_gravity")
var coyote_timer: float = 0.0
var jump_buffer: float = 0.0
var is_dashing: bool = false
var can_dash: bool = true
var facing_right: bool = true

func _physics_process(delta):
    # Gravity
    if not is_on_floor():
        velocity.y += gravity * delta
        coyote_timer -= delta
    else:
        coyote_timer = coyote_time
        can_dash = true

    # Jump buffer
    if Input.is_action_just_pressed("jump"):
        jump_buffer = jump_buffer_time
    else:
        jump_buffer -= delta

    # Jump
    if jump_buffer > 0 and coyote_timer > 0:
        velocity.y = jump_force
        jump_buffer = 0
        coyote_timer = 0

    # Variable jump height
    if Input.is_action_just_released("jump") and velocity.y < 0:
        velocity.y *= 0.5

    # Movement
    var direction = Input.get_axis("ui_left", "ui_right")
    velocity.x = move_toward(velocity.x, direction * speed, speed * 10 * delta)

    # Flip sprite
    if direction != 0:
        facing_right = direction > 0
        $Sprite2D.flip_h = not facing_right

    move_and_slide()
\`\`\`

### Top-Down Character (RPG / Zelda-style)
\`\`\`gdscript
extends CharacterBody2D

@export var speed: float = 150.0
@export var friction: float = 0.2
@export var acceleration: float = 0.3

var input_vector := Vector2.ZERO

func _physics_process(delta):
    input_vector = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")

    if input_vector != Vector2.ZERO:
        velocity = velocity.lerp(input_vector.normalized() * speed, acceleration)
        update_animation(input_vector)
    else:
        velocity = velocity.lerp(Vector2.ZERO, friction)

    move_and_slide()

func update_animation(dir: Vector2):
    if abs(dir.x) > abs(dir.y):
        $AnimatedSprite2D.play("walk_side")
        $AnimatedSprite2D.flip_h = dir.x < 0
    elif dir.y < 0:
        $AnimatedSprite2D.play("walk_up")
    else:
        $AnimatedSprite2D.play("walk_down")
\`\`\`

### Camera Follow with Smoothing
\`\`\`gdscript
extends Camera2D

@export var target_path: NodePath
@export var smoothing: float = 5.0
@export var look_ahead: float = 50.0
@export var shake_decay: float = 5.0

var target: Node2D
var shake_amount: float = 0.0

func _ready():
    target = get_node(target_path)

func _process(delta):
    if not target:
        return
    var target_pos = target.global_position
    target_pos.x += target.velocity.x / speed * look_ahead if target is CharacterBody2D else 0
    global_position = global_position.lerp(target_pos, smoothing * delta)

    # Screen shake
    if shake_amount > 0:
        offset = Vector2(randf_range(-1, 1), randf_range(-1, 1)) * shake_amount
        shake_amount = lerp(shake_amount, 0.0, shake_decay * delta)

func shake(amount: float):
    shake_amount = amount
\`\`\`

### Bullet / Projectile
\`\`\`gdscript
extends Area2D

@export var speed: float = 600.0
@export var damage: int = 10
@export var lifetime: float = 3.0
var direction := Vector2.RIGHT

func _ready():
    await get_tree().create_timer(lifetime).timeout
    queue_free()

func _physics_process(delta):
    position += direction * speed * delta

func _on_body_entered(body):
    if body.has_method("take_damage"):
        body.take_damage(damage)
    queue_free()
\`\`\`

### Spawner System
\`\`\`gdscript
extends Node2D

@export var enemy_scene: PackedScene
@export var spawn_interval: float = 2.0
@export var max_enemies: int = 10
@export var spawn_radius: float = 300.0

var enemy_count: int = 0

func _ready():
    var timer = Timer.new()
    timer.wait_time = spawn_interval
    timer.timeout.connect(spawn_enemy)
    add_child(timer)
    timer.start()

func spawn_enemy():
    if enemy_count >= max_enemies:
        return
    var enemy = enemy_scene.instantiate()
    var angle = randf() * TAU
    enemy.position = position + Vector2(cos(angle), sin(angle)) * randf_range(50, spawn_radius)
    enemy.tree_exiting.connect(func(): enemy_count -= 1)
    get_parent().add_child(enemy)
    enemy_count += 1
\`\`\`

### Health System Component
\`\`\`gdscript
extends Node

signal health_changed(current: int, maximum: int)
signal died

@export var max_health: int = 100
var current_health: int

func _ready():
    current_health = max_health

func take_damage(amount: int):
    current_health = max(0, current_health - amount)
    health_changed.emit(current_health, max_health)
    if current_health <= 0:
        died.emit()

func heal(amount: int):
    current_health = min(max_health, current_health + amount)
    health_changed.emit(current_health, max_health)
\`\`\`

### Collectible / Pickup
\`\`\`gdscript
extends Area2D

@export var value: int = 1
@export var collect_sound: AudioStream

func _on_body_entered(body):
    if body.is_in_group("player"):
        if body.has_method("collect"):
            body.collect(value)
        # Juicy pickup animation
        var tween = create_tween()
        tween.set_parallel()
        tween.tween_property(self, "scale", Vector2(1.5, 1.5), 0.1)
        tween.tween_property(self, "modulate:a", 0.0, 0.2)
        tween.chain().tween_callback(queue_free)
        if collect_sound:
            var player = AudioStreamPlayer.new()
            player.stream = collect_sound
            get_tree().root.add_child(player)
            player.play()
            player.finished.connect(player.queue_free)
\`\`\`

### Parallax Background
\`\`\`gdscript
extends ParallaxBackground

# Set up in scene:
# ParallaxBackground
#   ParallaxLayer (motion_scale = Vector2(0.2, 0))
#     Sprite2D (sky)
#   ParallaxLayer (motion_scale = Vector2(0.5, 0))
#     Sprite2D (mountains)
#   ParallaxLayer (motion_scale = Vector2(0.8, 0))
#     Sprite2D (trees)
\`\`\`

### Simple Enemy AI
\`\`\`gdscript
extends CharacterBody2D

@export var speed: float = 80.0
@export var chase_range: float = 200.0
@export var attack_range: float = 30.0
@export var damage: int = 10

var gravity = ProjectSettings.get_setting("physics/2d/default_gravity")
var player: Node2D = null
var direction: float = 1.0

func _ready():
    player = get_tree().get_first_node_in_group("player")

func _physics_process(delta):
    velocity.y += gravity * delta

    if player and position.distance_to(player.position) < chase_range:
        direction = sign(player.position.x - position.x)
        velocity.x = direction * speed
        if position.distance_to(player.position) < attack_range:
            if player.has_method("take_damage"):
                player.take_damage(damage)
    else:
        # Patrol: reverse at edges
        if is_on_wall():
            direction *= -1
        velocity.x = direction * speed * 0.5

    $Sprite2D.flip_h = direction < 0
    move_and_slide()
\`\`\``;
}
