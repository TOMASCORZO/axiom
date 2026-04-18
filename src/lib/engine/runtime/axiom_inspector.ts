/**
 * Axiom Inspector Autoload — GDScript source.
 *
 * Injected into every project as a Godot autoload singleton. It bridges the
 * running scene tree to the React app via JavaScriptBridge (which talks to
 * the iframe shell, which talks to window.parent via postMessage).
 *
 * Wire protocol mirrors src/lib/engine/bridge.ts:
 *   Inbound (parent → engine):   scene-tree, node-info, raycast, set-property,
 *                                set-transform, add-node, delete-node, select-node
 *   Outbound (engine → parent):  response (paired by requestId), selection-changed,
 *                                scene-tree-changed, node-transform-changed,
 *                                inspector-ready
 *
 * The shell (axiom.html) exposes two JS hooks the script uses:
 *   window.__axiomPostEvent(jsonStr)   — relay to window.parent.postMessage
 *   window.__axiomInspectorCmd(jsonStr) — installed by THIS script as a callback;
 *                                         shell calls it for every protocol command
 *
 * When the day comes to migrate this to C++ EngineDebugger captures, the wire
 * format does not change — only the implementation behind these handlers does.
 * See src/lib/engine/runtime/README.md for the migration plan.
 */

export const AXIOM_INSPECTOR_GD = `# Axiom Inspector Autoload — auto-generated, do not edit.
# Source: src/lib/engine/runtime/axiom_inspector.ts
extends Node

# ── Gizmo constants ──────────────────────────────────────────────────
const GIZMO_LAYER_BIT: int = 20            # Dedicated physics layer for handle picking
const GIZMO_SCREEN_SIZE: float = 0.18      # Gizmo radius at 1m camera distance (perspective)
const GIZMO_AXIS_LENGTH: float = 1.0       # Local length of an axis
const GIZMO_AXIS_THICKNESS: float = 0.04
const GIZMO_TIP_SIZE: float = 0.18
const GIZMO_RING_RADIUS: float = 0.9
const GIZMO_RING_TUBE: float = 0.04

var _command_callback: JavaScriptObject
var _selection_path: String = ""

# ── Gizmo state ──────────────────────────────────────────────────────
var _gizmo_mode: String = "translate"   # translate | rotate | scale | none
var _gizmo_root: Node3D = null          # parent of all handle visuals; lives under root scene
var _gizmo_target: Node3D = null        # node currently being manipulated
var _gizmo_handles: Array = []          # [{axis: Vector3, body: StaticBody3D, mesh: MeshInstance3D, base_color: Color}]

# Drag state
var _gizmo_dragging: bool = false
var _gizmo_drag_axis: Vector3 = Vector3.ZERO
var _gizmo_drag_plane: Plane = Plane()
var _gizmo_drag_start_transform: Transform3D = Transform3D()
var _gizmo_drag_start_world_point: Vector3 = Vector3.ZERO
var _gizmo_drag_start_value: float = 0.0
var _gizmo_drag_origin: Vector3 = Vector3.ZERO

func _ready() -> void:
	if not OS.has_feature("web"):
		push_warning("[AxiomInspector] Not running in web build — disabled.")
		return

	var window := JavaScriptBridge.get_interface("window")
	if window == null:
		push_warning("[AxiomInspector] No window interface — JavaScriptBridge unavailable.")
		return

	_command_callback = JavaScriptBridge.create_callback(_on_command_from_shell)
	window.__axiomInspectorCmd = _command_callback

	_post_event({"type": "inspector-ready"})


func _on_command_from_shell(args: Array) -> void:
	if args.is_empty():
		return
	var json_str: String = String(args[0])
	var parsed: Variant = JSON.parse_string(json_str)
	if not (parsed is Dictionary):
		return

	var cmd: Dictionary = parsed
	var cmd_type: String = cmd.get("type", "")
	var request_id: String = cmd.get("requestId", "")

	match cmd_type:
		"scene-tree":
			_send_response(request_id, _serialize_tree(get_tree().root))
		"node-info":
			var info := _serialize_node_info(cmd.get("path", ""))
			if info.has("__error"):
				_send_error(request_id, info.__error)
			else:
				_send_response(request_id, info)
		"raycast":
			_send_response(request_id, _do_raycast(cmd.get("screenX", 0.0), cmd.get("screenY", 0.0)))
		"set-property":
			_do_set_property(request_id, cmd.get("path", ""), cmd.get("property", ""), cmd.get("value"))
		"set-transform":
			_do_set_transform(request_id, cmd.get("path", ""), cmd.get("patch", {}))
		"add-node":
			_do_add_node(request_id, cmd.get("parentPath", ""), cmd.get("nodeType", ""), cmd.get("nodeName", ""))
		"delete-node":
			_do_delete_node(request_id, cmd.get("path", ""))
		"select-node":
			var sel = cmd.get("path", null)
			_selection_path = String(sel) if sel != null else ""
			_post_event({"type": "selection-changed", "path": (_selection_path if _selection_path != "" else null)})
			_refresh_gizmo()
		"set-gizmo-mode":
			_gizmo_mode = String(cmd.get("mode", "translate"))
			_refresh_gizmo()
		_:
			_send_error(request_id, "Unknown command: " + cmd_type)


# ── Serialization ────────────────────────────────────────────────────

func _serialize_tree(node: Node) -> Dictionary:
	var children := []
	for child in node.get_children():
		children.append(_serialize_tree(child))
	return {
		"path": String(node.get_path()),
		"name": str(node.name),
		"type": node.get_class(),
		"visible": _safe_visible(node),
		"children": children,
	}


func _serialize_node_info(node_path: String) -> Dictionary:
	var node := _resolve_node(node_path)
	if node == null:
		return {"__error": "Node not found: " + node_path}

	var props := []
	for prop_info in node.get_property_list():
		var usage: int = int(prop_info.get("usage", 0))
		var visible_to_editor := (usage & PROPERTY_USAGE_EDITOR) != 0
		var visible_to_storage := (usage & PROPERTY_USAGE_STORAGE) != 0
		if not (visible_to_editor or visible_to_storage):
			continue

		var prop_name: String = prop_info.get("name", "")
		if prop_name == "" or prop_name.begins_with("_") or prop_name == "script":
			continue

		var value: Variant = node.get(prop_name)
		props.append({
			"name": prop_name,
			"type": _godot_type_name(int(prop_info.get("type", 0))),
			"value": _serialize_value(value),
			"hint": _godot_hint_name(int(prop_info.get("hint", 0))),
			"hintString": String(prop_info.get("hint_string", "")),
			"usage": "editor" if visible_to_editor else "storage",
		})

	var script_path: Variant = null
	var script_obj: Variant = node.get_script()
	if script_obj != null and script_obj.has_method("get_path"):
		script_path = script_obj.resource_path

	return {
		"path": String(node.get_path()),
		"name": str(node.name),
		"type": node.get_class(),
		"properties": props,
		"script": script_path,
	}


func _serialize_value(v: Variant) -> Variant:
	if v is Vector2:
		return [v.x, v.y]
	if v is Vector2i:
		return [v.x, v.y]
	if v is Vector3:
		return [v.x, v.y, v.z]
	if v is Vector3i:
		return [v.x, v.y, v.z]
	if v is Vector4:
		return [v.x, v.y, v.z, v.w]
	if v is Color:
		return {"r": v.r, "g": v.g, "b": v.b, "a": v.a}
	if v is NodePath:
		return String(v)
	if v is StringName:
		return String(v)
	if v is Object:
		# Don't serialize object refs through the wire — too lossy for v0.
		# Future: emit a typed handle the React side can use to fetch_node_info.
		return null
	return v


func _serialize_transform(node: Node) -> Dictionary:
	if node is Node2D:
		return {
			"position": [node.position.x, node.position.y],
			"rotation": node.rotation,
			"scale": [node.scale.x, node.scale.y],
		}
	if node is Node3D:
		return {
			"position": [node.position.x, node.position.y, node.position.z],
			"rotation": [node.rotation.x, node.rotation.y, node.rotation.z],
			"scale": [node.scale.x, node.scale.y, node.scale.z],
		}
	return {}


# ── Mutations ────────────────────────────────────────────────────────

func _do_set_property(req_id: String, node_path: String, prop: String, value: Variant) -> void:
	var node := _resolve_node(node_path)
	if node == null:
		_send_error(req_id, "Node not found: " + node_path)
		return
	var current: Variant = node.get(prop)
	var deserialized: Variant = _deserialize_value(value, current)
	node.set(prop, deserialized)
	_send_response(req_id, null)


func _do_set_transform(req_id: String, node_path: String, patch: Dictionary) -> void:
	var node := _resolve_node(node_path)
	if node == null:
		_send_error(req_id, "Node not found: " + node_path)
		return

	if node is Node2D:
		if patch.has("position"):
			var p = patch.position
			node.position = Vector2(float(p[0]), float(p[1]))
		if patch.has("rotation"):
			var r = patch.rotation
			node.rotation = float(r[0]) if r is Array else float(r)
		if patch.has("scale"):
			var s = patch.scale
			node.scale = Vector2(float(s[0]), float(s[1]))
	elif node is Node3D:
		if patch.has("position"):
			var p = patch.position
			var pz: float = float(p[2]) if p.size() > 2 else 0.0
			node.position = Vector3(float(p[0]), float(p[1]), pz)
		if patch.has("rotation") and patch.rotation is Array:
			var r = patch.rotation
			node.rotation = Vector3(float(r[0]), float(r[1]), float(r[2]))
		if patch.has("scale"):
			var s = patch.scale
			var sz: float = float(s[2]) if s.size() > 2 else 1.0
			node.scale = Vector3(float(s[0]), float(s[1]), sz)
	else:
		_send_error(req_id, "Node has no transform: " + node_path)
		return

	_send_response(req_id, null)
	_post_event({
		"type": "node-transform-changed",
		"path": String(node.get_path()),
		"transform": _serialize_transform(node),
	})


func _do_add_node(req_id: String, parent_path: String, type_name: String, node_name: String) -> void:
	var parent := _resolve_node(parent_path)
	if parent == null:
		_send_error(req_id, "Parent not found: " + parent_path)
		return
	if not ClassDB.class_exists(type_name):
		_send_error(req_id, "Unknown class: " + type_name)
		return
	var node = ClassDB.instantiate(type_name)
	if node == null or not (node is Node):
		_send_error(req_id, "Failed to instantiate: " + type_name)
		return
	node.name = node_name
	parent.add_child(node)
	_send_response(req_id, {"path": String(node.get_path())})
	_post_event({"type": "scene-tree-changed"})


func _do_delete_node(req_id: String, node_path: String) -> void:
	var node := _resolve_node(node_path)
	if node == null:
		_send_error(req_id, "Node not found: " + node_path)
		return
	if node == get_tree().root:
		_send_error(req_id, "Cannot delete root")
		return
	node.queue_free()
	_send_response(req_id, null)
	_post_event({"type": "scene-tree-changed"})


# ── Raycast ──────────────────────────────────────────────────────────

func _do_raycast(screen_x: float, screen_y: float) -> Array:
	# v0: 2D point query against PhysicsServer2D. 3D camera-projection raycast
	# comes in Sprint 2 with the gizmos.
	var hits: Array = []
	var viewport := get_tree().root.get_viewport()
	if viewport == null:
		return hits
	var world_2d := viewport.world_2d if "world_2d" in viewport else null
	if world_2d == null:
		return hits
	var space := world_2d.direct_space_state
	if space == null:
		return hits

	var query := PhysicsPointQueryParameters2D.new()
	query.position = Vector2(screen_x, screen_y)
	query.collide_with_areas = true
	query.collide_with_bodies = true
	var results := space.intersect_point(query, 32)
	for hit in results:
		var collider = hit.get("collider")
		if collider != null:
			hits.append({
				"path": String(collider.get_path()),
				"distance": 0.0,
				"position": [screen_x, screen_y, 0.0],
			})
	return hits


# ── Helpers ──────────────────────────────────────────────────────────

func _resolve_node(path: String) -> Node:
	if path == "" or path == "/root":
		return get_tree().root
	return get_tree().root.get_node_or_null(NodePath(path))


func _safe_visible(node: Node) -> bool:
	if node is CanvasItem:
		return node.visible
	if node is Node3D:
		return node.visible
	return true


func _deserialize_value(v: Variant, current: Variant) -> Variant:
	if current is Vector2 and v is Array and (v as Array).size() >= 2:
		return Vector2(float(v[0]), float(v[1]))
	if current is Vector3 and v is Array and (v as Array).size() >= 3:
		return Vector3(float(v[0]), float(v[1]), float(v[2]))
	if current is Vector4 and v is Array and (v as Array).size() >= 4:
		return Vector4(float(v[0]), float(v[1]), float(v[2]), float(v[3]))
	if current is Color and v is Dictionary:
		var d: Dictionary = v
		return Color(float(d.get("r", 0)), float(d.get("g", 0)), float(d.get("b", 0)), float(d.get("a", 1)))
	if current is NodePath and v is String:
		return NodePath(v)
	if current is StringName and v is String:
		return StringName(v)
	return v


func _godot_type_name(t: int) -> String:
	match t:
		TYPE_BOOL: return "bool"
		TYPE_INT: return "int"
		TYPE_FLOAT: return "float"
		TYPE_STRING, TYPE_STRING_NAME: return "string"
		TYPE_VECTOR2, TYPE_VECTOR2I: return "vector2"
		TYPE_VECTOR3, TYPE_VECTOR3I: return "vector3"
		TYPE_VECTOR4, TYPE_VECTOR4I: return "vector4"
		TYPE_COLOR: return "color"
		TYPE_NODE_PATH: return "node_path"
		TYPE_OBJECT: return "resource"
		_: return "object"


func _godot_hint_name(h: int) -> String:
	match h:
		PROPERTY_HINT_RANGE: return "range"
		PROPERTY_HINT_FILE: return "file"
		PROPERTY_HINT_DIR: return "dir"
		PROPERTY_HINT_COLOR_NO_ALPHA: return "color_no_alpha"
		PROPERTY_HINT_ENUM: return "enum"
		PROPERTY_HINT_MULTILINE_TEXT: return "multiline"
		PROPERTY_HINT_RESOURCE_TYPE: return "resource_type"
		PROPERTY_HINT_LAYERS_2D_PHYSICS, PROPERTY_HINT_LAYERS_2D_RENDER: return "layers_2d"
		PROPERTY_HINT_LAYERS_3D_PHYSICS, PROPERTY_HINT_LAYERS_3D_RENDER: return "layers_3d"
		_: return "none"


# ── Outbound bridge ──────────────────────────────────────────────────

func _send_response(req_id: String, data: Variant) -> void:
	_post_event({"type": "response", "requestId": req_id, "ok": true, "data": data})


func _send_error(req_id: String, err_msg: String) -> void:
	_post_event({"type": "response", "requestId": req_id, "ok": false, "error": err_msg})


func _post_event(msg: Dictionary) -> void:
	var window := JavaScriptBridge.get_interface("window")
	if window == null:
		return
	window.__axiomPostEvent(JSON.stringify(msg))


# ── 3D Gizmo: lifecycle ──────────────────────────────────────────────

func _refresh_gizmo() -> void:
	if _selection_path == "" or _gizmo_mode == "none":
		_clear_gizmo()
		return
	var node := _resolve_node(_selection_path)
	if node == null or not (node is Node3D):
		_clear_gizmo()
		return
	if _gizmo_root != null and _gizmo_target == node:
		_clear_handles_only()
		_build_handles()
		return
	_clear_gizmo()
	_gizmo_target = node
	_build_gizmo_root()
	_build_handles()


func _clear_gizmo() -> void:
	_gizmo_dragging = false
	_gizmo_target = null
	if _gizmo_root != null and is_instance_valid(_gizmo_root):
		_gizmo_root.queue_free()
	_gizmo_root = null
	_gizmo_handles.clear()


func _clear_handles_only() -> void:
	if _gizmo_root == null:
		return
	for child in _gizmo_root.get_children():
		child.queue_free()
	_gizmo_handles.clear()


func _build_gizmo_root() -> void:
	_gizmo_root = Node3D.new()
	_gizmo_root.name = "__AxiomGizmo"
	_gizmo_root.top_level = true
	get_tree().root.add_child(_gizmo_root)


func _build_handles() -> void:
	var x_color := Color(1.0, 0.30, 0.30)
	var y_color := Color(0.30, 1.0, 0.30)
	var z_color := Color(0.40, 0.55, 1.0)
	match _gizmo_mode:
		"translate":
			_make_axis_handle(0, x_color, "translate")
			_make_axis_handle(1, y_color, "translate")
			_make_axis_handle(2, z_color, "translate")
		"rotate":
			_make_axis_handle(0, x_color, "rotate")
			_make_axis_handle(1, y_color, "rotate")
			_make_axis_handle(2, z_color, "rotate")
		"scale":
			_make_axis_handle(0, x_color, "scale")
			_make_axis_handle(1, y_color, "scale")
			_make_axis_handle(2, z_color, "scale")
		_:
			pass


func _gizmo_material(color: Color) -> StandardMaterial3D:
	var mat := StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.albedo_color = color
	mat.no_depth_test = true
	mat.render_priority = 64
	return mat


func _make_axis_handle(axis_idx: int, color: Color, mode: String) -> void:
	# Holder rotates so its local +Y points along the chosen world axis.
	var holder := Node3D.new()
	if axis_idx == 0:
		holder.rotation = Vector3(0, 0, -PI * 0.5)
	elif axis_idx == 2:
		holder.rotation = Vector3(PI * 0.5, 0, 0)
	# axis_idx == 1 → identity (cylinder default is +Y)

	var axis_world: Vector3 = Vector3.ZERO
	axis_world[axis_idx] = 1.0

	var body := StaticBody3D.new()
	body.collision_layer = 0
	body.set_collision_layer_value(GIZMO_LAYER_BIT, true)
	body.collision_mask = 0

	if mode == "rotate":
		var torus := MeshInstance3D.new()
		var torus_mesh := TorusMesh.new()
		torus_mesh.inner_radius = GIZMO_RING_RADIUS - GIZMO_RING_TUBE
		torus_mesh.outer_radius = GIZMO_RING_RADIUS + GIZMO_RING_TUBE
		torus.mesh = torus_mesh
		torus.material_override = _gizmo_material(color)
		holder.add_child(torus)
		var picker := CylinderShape3D.new()
		picker.radius = GIZMO_RING_RADIUS + GIZMO_RING_TUBE * 1.5
		picker.height = GIZMO_RING_TUBE * 4.0
		var col := CollisionShape3D.new()
		col.shape = picker
		body.add_child(col)
	else:
		# translate / scale: shaft + tip
		var shaft := MeshInstance3D.new()
		var cyl := CylinderMesh.new()
		cyl.top_radius = GIZMO_AXIS_THICKNESS * 0.5
		cyl.bottom_radius = GIZMO_AXIS_THICKNESS * 0.5
		cyl.height = GIZMO_AXIS_LENGTH
		shaft.mesh = cyl
		shaft.material_override = _gizmo_material(color)
		shaft.position = Vector3(0, GIZMO_AXIS_LENGTH * 0.5, 0)
		holder.add_child(shaft)

		var tip := MeshInstance3D.new()
		if mode == "translate":
			var cone := CylinderMesh.new()
			cone.top_radius = 0.0
			cone.bottom_radius = GIZMO_TIP_SIZE * 0.5
			cone.height = GIZMO_TIP_SIZE
			tip.mesh = cone
		else:
			var box := BoxMesh.new()
			box.size = Vector3(GIZMO_TIP_SIZE, GIZMO_TIP_SIZE, GIZMO_TIP_SIZE)
			tip.mesh = box
		tip.material_override = _gizmo_material(color)
		tip.position = Vector3(0, GIZMO_AXIS_LENGTH + GIZMO_TIP_SIZE * 0.5, 0)
		holder.add_child(tip)

		var capsule := CapsuleShape3D.new()
		capsule.radius = max(GIZMO_AXIS_THICKNESS, GIZMO_TIP_SIZE * 0.5) * 1.5
		capsule.height = GIZMO_AXIS_LENGTH + GIZMO_TIP_SIZE
		var col := CollisionShape3D.new()
		col.shape = capsule
		col.position = Vector3(0, GIZMO_AXIS_LENGTH * 0.5 + GIZMO_TIP_SIZE * 0.5, 0)
		body.add_child(col)

	holder.add_child(body)
	_gizmo_root.add_child(holder)
	_gizmo_handles.append({"axis": axis_world, "body": body, "color": color, "axis_idx": axis_idx})


# ── 3D Gizmo: per-frame placement ────────────────────────────────────

func _process(_delta: float) -> void:
	if _gizmo_root == null:
		return
	if _gizmo_target == null or not is_instance_valid(_gizmo_target):
		_clear_gizmo()
		return
	var cam := _get_active_camera_3d()
	if cam == null:
		_gizmo_root.visible = false
		return
	_gizmo_root.visible = true
	# World-aligned at the target's origin.
	_gizmo_root.global_position = _gizmo_target.global_position
	_gizmo_root.global_basis = Basis()
	# Constant screen size.
	var s: float
	if cam.projection == Camera3D.PROJECTION_ORTHOGONAL:
		s = max(cam.size * GIZMO_SCREEN_SIZE * 0.25, 0.05)
	else:
		var dist: float = cam.global_position.distance_to(_gizmo_target.global_position)
		s = max(dist * GIZMO_SCREEN_SIZE, 0.05)
	_gizmo_root.scale = Vector3(s, s, s)


func _get_active_camera_3d() -> Camera3D:
	var viewport := get_tree().root.get_viewport()
	if viewport == null:
		return null
	return viewport.get_camera_3d()


# ── 3D Gizmo: input + drag ───────────────────────────────────────────

func _unhandled_input(event: InputEvent) -> void:
	if _gizmo_root == null or _gizmo_target == null:
		return
	var cam := _get_active_camera_3d()
	if cam == null:
		return

	if event is InputEventMouseButton:
		var mb: InputEventMouseButton = event
		if mb.button_index != MOUSE_BUTTON_LEFT:
			return
		if mb.pressed:
			var picked: Variant = _pick_handle(mb.position, cam)
			if picked != null:
				_start_drag(picked, mb.position, cam)
				get_viewport().set_input_as_handled()
		elif _gizmo_dragging:
			_end_drag()
			get_viewport().set_input_as_handled()
		return

	if event is InputEventMouseMotion and _gizmo_dragging:
		var mm: InputEventMouseMotion = event
		_update_drag(mm.position, cam)
		get_viewport().set_input_as_handled()


func _pick_handle(screen_pos: Vector2, cam: Camera3D) -> Variant:
	var world := get_tree().root.get_world_3d()
	if world == null:
		return null
	var space := world.direct_space_state
	if space == null:
		return null
	var origin: Vector3 = cam.project_ray_origin(screen_pos)
	var direction: Vector3 = cam.project_ray_normal(screen_pos)
	var to: Vector3 = origin + direction * 4096.0
	var query := PhysicsRayQueryParameters3D.create(origin, to, 1 << (GIZMO_LAYER_BIT - 1))
	query.collide_with_bodies = true
	query.collide_with_areas = false
	var hit := space.intersect_ray(query)
	if hit.is_empty():
		return null
	var collider = hit.get("collider", null)
	if collider == null:
		return null
	for h in _gizmo_handles:
		if h.body == collider:
			return h
	return null


func _start_drag(handle: Dictionary, screen_pos: Vector2, cam: Camera3D) -> void:
	_gizmo_dragging = true
	_gizmo_drag_axis = (handle.axis as Vector3).normalized()
	_gizmo_drag_start_transform = _gizmo_target.global_transform
	_gizmo_drag_origin = _gizmo_target.global_position

	var view_forward: Vector3 = -cam.global_transform.basis.z
	if _gizmo_mode == "rotate":
		_gizmo_drag_plane = Plane(_gizmo_drag_axis, _gizmo_drag_axis.dot(_gizmo_drag_origin))
	else:
		var helper: Vector3 = _gizmo_drag_axis.cross(view_forward)
		if helper.length_squared() < 0.0001:
			helper = _gizmo_drag_axis.cross(Vector3.UP)
			if helper.length_squared() < 0.0001:
				helper = _gizmo_drag_axis.cross(Vector3.RIGHT)
		var normal: Vector3 = helper.cross(_gizmo_drag_axis).normalized()
		_gizmo_drag_plane = Plane(normal, normal.dot(_gizmo_drag_origin))

	var hit: Variant = _ray_plane_hit(screen_pos, cam)
	if hit == null:
		_gizmo_dragging = false
		return
	_gizmo_drag_start_world_point = hit
	if _gizmo_mode == "rotate":
		var perp := _perp_basis(_gizmo_drag_axis)
		var v: Vector3 = _gizmo_drag_start_world_point - _gizmo_drag_origin
		_gizmo_drag_start_value = atan2(v.dot(perp[1]), v.dot(perp[0]))
	elif _gizmo_mode == "scale":
		var d: Vector3 = _gizmo_drag_start_world_point - _gizmo_drag_origin
		var dist: float = d.dot(_gizmo_drag_axis)
		if absf(dist) < 0.001:
			dist = (0.001 if dist >= 0.0 else -0.001)
		_gizmo_drag_start_value = dist


func _update_drag(screen_pos: Vector2, cam: Camera3D) -> void:
	var hit: Variant = _ray_plane_hit(screen_pos, cam)
	if hit == null:
		return
	match _gizmo_mode:
		"translate":
			var delta: float = (hit - _gizmo_drag_start_world_point).dot(_gizmo_drag_axis)
			var new_pos: Vector3 = _gizmo_drag_start_transform.origin + _gizmo_drag_axis * delta
			_gizmo_target.global_position = new_pos
			_emit_live_transform()
		"rotate":
			var perp := _perp_basis(_gizmo_drag_axis)
			var v: Vector3 = hit - _gizmo_drag_origin
			var angle: float = atan2(v.dot(perp[1]), v.dot(perp[0]))
			var delta_angle: float = angle - _gizmo_drag_start_value
			var rot := Basis(_gizmo_drag_axis, delta_angle)
			var new_basis: Basis = rot * _gizmo_drag_start_transform.basis
			_gizmo_target.global_transform = Transform3D(new_basis, _gizmo_drag_start_transform.origin)
			_emit_live_transform()
		"scale":
			var d: Vector3 = hit - _gizmo_drag_origin
			var current: float = d.dot(_gizmo_drag_axis)
			var ratio: float = current / _gizmo_drag_start_value
			if ratio < 0.01:
				ratio = 0.01
			var idx: int = _axis_index(_gizmo_drag_axis)
			var start_scale: Vector3 = _gizmo_drag_start_transform.basis.get_scale()
			var new_scale: Vector3 = start_scale
			if idx == 0:
				new_scale.x = max(start_scale.x * ratio, 0.001)
			elif idx == 1:
				new_scale.y = max(start_scale.y * ratio, 0.001)
			elif idx == 2:
				new_scale.z = max(start_scale.z * ratio, 0.001)
			var b: Basis = _gizmo_drag_start_transform.basis.orthonormalized()
			b.x = b.x * new_scale.x
			b.y = b.y * new_scale.y
			b.z = b.z * new_scale.z
			_gizmo_target.global_transform = Transform3D(b, _gizmo_drag_start_transform.origin)
			_emit_live_transform()


func _end_drag() -> void:
	_gizmo_dragging = false
	_emit_live_transform()


func _ray_plane_hit(screen_pos: Vector2, cam: Camera3D) -> Variant:
	var origin: Vector3 = cam.project_ray_origin(screen_pos)
	var direction: Vector3 = cam.project_ray_normal(screen_pos)
	return _gizmo_drag_plane.intersects_ray(origin, direction)


func _perp_basis(axis: Vector3) -> Array:
	var a: Vector3 = axis.normalized()
	var u: Vector3 = Vector3.UP if absf(a.dot(Vector3.UP)) < 0.9 else Vector3.RIGHT
	u = (u - a * u.dot(a)).normalized()
	var v: Vector3 = a.cross(u).normalized()
	return [u, v]


func _axis_index(axis: Vector3) -> int:
	if absf(axis.x) > 0.5:
		return 0
	if absf(axis.y) > 0.5:
		return 1
	if absf(axis.z) > 0.5:
		return 2
	return -1


func _emit_live_transform() -> void:
	if _gizmo_target == null or not is_instance_valid(_gizmo_target):
		return
	_post_event({
		"type": "node-transform-changed",
		"path": String(_gizmo_target.get_path()),
		"transform": _serialize_transform(_gizmo_target),
	})
`;

/** Path inside the project's virtual filesystem where the script is written. */
export const AXIOM_INSPECTOR_PATH = 'addons/axiom/inspector.gd';

/** Autoload registration name. Godot exposes it as a global singleton. */
export const AXIOM_INSPECTOR_AUTOLOAD_NAME = 'AxiomInspector';
