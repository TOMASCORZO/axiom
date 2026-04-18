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

var _command_callback: JavaScriptObject
var _selection_path: String = ""

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
`;

/** Path inside the project's virtual filesystem where the script is written. */
export const AXIOM_INSPECTOR_PATH = 'addons/axiom/inspector.gd';

/** Autoload registration name. Godot exposes it as a global singleton. */
export const AXIOM_INSPECTOR_AUTOLOAD_NAME = 'AxiomInspector';
