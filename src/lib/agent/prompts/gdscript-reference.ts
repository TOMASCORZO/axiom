/**
 * Comprehensive GDScript 4.x Reference — Godogen-style deep knowledge.
 * AxiomScript is identical to GDScript 4.x, files use .axs extension.
 */

export function getGDScriptReference(): string {
    return `## AxiomScript Reference (identical to GDScript 4.x)
Files use the \`.axs\` extension. Full GDScript 4.x syntax is supported.

### Variable Declarations
\`\`\`gdscript
var health: int = 100                    # Typed variable
var speed := 200.0                       # Type inference
@export var jump_force: float = -400.0   # Exposed to editor
@export_range(0, 100) var volume: int = 50
@onready var sprite = $Sprite2D          # Resolved when node enters tree
const MAX_SPEED = 500.0                  # Constant
enum State { IDLE, RUNNING, JUMPING, FALLING }
var current_state: State = State.IDLE
\`\`\`

### Functions
\`\`\`gdscript
func _ready():                           # Called when node enters tree
func _process(delta: float):             # Called every frame
func _physics_process(delta: float):     # Called every physics tick (fixed)
func _input(event: InputEvent):          # Called on any input event
func _unhandled_input(event: InputEvent): # Unhandled input
func custom_function(arg1: int, arg2: String = "default") -> bool:
    return true
\`\`\`

### Signals
\`\`\`gdscript
signal health_changed(new_value: int)
signal died

# Emitting
health_changed.emit(health)
died.emit()

# Connecting
button.pressed.connect(_on_button_pressed)
enemy.died.connect(_on_enemy_died)

# Lambda connections
timer.timeout.connect(func(): queue_free())
\`\`\`

### Node Access
\`\`\`gdscript
$ChildNode                    # Get direct child
$Path/To/DeepChild            # Get nested child
get_node("Path/To/Node")      # Same as $ but dynamic
get_parent()                  # Parent node
get_tree()                    # Scene tree
get_tree().current_scene      # Current scene root
owner                         # Scene root this node belongs to
\`\`\`

### Common Node Operations
\`\`\`gdscript
# Instantiate scenes
var scene = preload("res://scenes/enemy.scene")
var instance = scene.instantiate()
add_child(instance)

# Remove nodes
node.queue_free()             # Safe removal (end of frame)
node.free()                   # Immediate removal (dangerous)

# Reparenting
node.reparent(new_parent)

# Groups
add_to_group("enemies")
is_in_group("enemies")
get_tree().get_nodes_in_group("enemies")
get_tree().call_group("enemies", "take_damage", 10)
\`\`\`

### Input Handling
\`\`\`gdscript
# Action-based (defined in project.axiom)
Input.is_action_pressed("ui_right")      # Held down
Input.is_action_just_pressed("ui_accept") # Just pressed this frame
Input.is_action_just_released("jump")     # Just released
Input.get_axis("ui_left", "ui_right")     # Returns -1, 0, or 1
Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down") # Returns Vector2

# Direct key/mouse
Input.is_key_pressed(KEY_SPACE)
Input.is_mouse_button_pressed(MOUSE_BUTTON_LEFT)
\`\`\`

### Physics Bodies
\`\`\`gdscript
# CharacterBody2D — player-controlled movement
extends CharacterBody2D
func _physics_process(delta):
    velocity.y += gravity * delta          # Apply gravity
    var dir = Input.get_axis("ui_left", "ui_right")
    velocity.x = dir * speed
    if Input.is_action_just_pressed("jump") and is_on_floor():
        velocity.y = jump_force
    move_and_slide()                       # Handles collision response

# RigidBody2D — physics-simulated
extends RigidBody2D
func _ready():
    apply_central_impulse(Vector2(100, -200))
    gravity_scale = 2.0
    linear_damp = 0.5

# Area2D — detection zones (no collision response)
extends Area2D
func _ready():
    body_entered.connect(_on_body_entered)
    area_entered.connect(_on_area_entered)
func _on_body_entered(body: Node2D):
    if body.is_in_group("player"):
        collect()
\`\`\`

### Timers
\`\`\`gdscript
# Programmatic timer
var timer = Timer.new()
timer.wait_time = 2.0
timer.one_shot = true
timer.timeout.connect(_on_timeout)
add_child(timer)
timer.start()

# Inline await
await get_tree().create_timer(1.5).timeout
\`\`\`

### Tweens (Animation)
\`\`\`gdscript
var tween = create_tween()
tween.tween_property(sprite, "position", Vector2(100, 0), 0.5)
tween.tween_property(sprite, "modulate:a", 0.0, 0.3)  # Fade out
tween.tween_callback(queue_free)                        # Then remove

# Chaining
tween.set_ease(Tween.EASE_OUT).set_trans(Tween.TRANS_BOUNCE)
tween.set_parallel()  # Run next tweens in parallel
tween.tween_property(node, "scale", Vector2(2, 2), 0.2)
tween.tween_property(node, "rotation", PI, 0.2)
\`\`\`

### Math & Vectors
\`\`\`gdscript
# Vector2
var direction = (target.position - position).normalized()
var distance = position.distance_to(target.position)
var angle = position.angle_to_point(target.position)
var lerped = position.lerp(target.position, 0.1)  # Smooth movement

# Common math
clamp(value, min, max)
lerp(a, b, t)
move_toward(current, target, delta)
randi_range(min, max)          # Random integer
randf_range(min, max)          # Random float
\`\`\`

### Data Structures
\`\`\`gdscript
# Arrays
var arr = [1, 2, 3]
arr.append(4)
arr.push_front(0)
arr.pop_back()
arr.find(2)          # Returns index or -1
arr.shuffle()
arr.sort()
arr.filter(func(x): return x > 2)
arr.map(func(x): return x * 2)

# Dictionaries
var dict = {"key": "value", "hp": 100}
dict["new_key"] = 42
dict.has("key")
dict.keys()
dict.values()
dict.erase("key")
dict.merge(other_dict)
\`\`\`

### Scene Management
\`\`\`gdscript
# Change scene
get_tree().change_scene_to_file("res://scenes/game_over.scene")

# Reload current scene
get_tree().reload_current_scene()

# Pause
get_tree().paused = true
# Mark node to process during pause:
process_mode = Node.PROCESS_MODE_ALWAYS

# Quit
get_tree().quit()
\`\`\`

### Resources & Saving
\`\`\`gdscript
# Save/Load
var save_data = {"score": score, "level": level}
var file = FileAccess.open("user://save.dat", FileAccess.WRITE)
file.store_var(save_data)
file.close()

var file2 = FileAccess.open("user://save.dat", FileAccess.READ)
var loaded = file2.get_var()
file2.close()
\`\`\`

### Autoload / Singletons
\`\`\`gdscript
# In project.axiom: autoload/globals = "res://scripts/globals.axs"
# Then accessible anywhere:
Globals.score += 10
Globals.save_game()
\`\`\`

### Common Patterns
\`\`\`gdscript
# State Machine
enum State { IDLE, RUN, JUMP, FALL, ATTACK }
var state = State.IDLE

func _physics_process(delta):
    match state:
        State.IDLE:
            if Input.get_axis("ui_left", "ui_right") != 0:
                state = State.RUN
            if Input.is_action_just_pressed("jump"):
                state = State.JUMP
        State.RUN:
            velocity.x = Input.get_axis("ui_left", "ui_right") * speed
            if not is_on_floor():
                state = State.FALL
        State.JUMP:
            velocity.y = jump_force
            state = State.FALL
        State.FALL:
            velocity.y += gravity * delta
            if is_on_floor():
                state = State.IDLE
    move_and_slide()

# Object Pool
var pool: Array[Node2D] = []
func get_from_pool() -> Node2D:
    if pool.size() > 0:
        var obj = pool.pop_back()
        obj.visible = true
        return obj
    return bullet_scene.instantiate()

func return_to_pool(obj: Node2D):
    obj.visible = false
    pool.append(obj)
\`\`\``;
}
