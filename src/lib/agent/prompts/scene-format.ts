/**
 * Axiom Scene Format Reference — how .scene files are structured.
 */

export function getSceneFormatReference(is3D: boolean): string {
    return `## Scene Format (.scene files)
Scenes use Axiom's text-based scene format:

\`\`\`
[axiom_scene format=3]

[node name="Main" type="${is3D ? 'Entity3D' : 'Entity2D'}"]

[node name="Player" type="${is3D ? 'CharacterBody3D' : 'CharacterBody2D'}" parent="."]
script = ExtResource("scripts/player.axs")

${is3D
        ? `[node name="PlayerMesh" type="MeshInstance3D" parent="Player"]
mesh = CapsuleMesh

[node name="PlayerCollision" type="CollisionShape3D" parent="Player"]
shape = CapsuleShape3D

[node name="Head" type="Node3D" parent="Player"]

[node name="Camera" type="Camera3D" parent="Player/Head"]
position = Vector3(0, 1.6, 0)

[node name="Light" type="DirectionalLight3D" parent="."]
rotation = Vector3(-0.785, -0.785, 0)
shadow_enabled = true

[node name="Floor" type="StaticBody3D" parent="."]

[node name="FloorMesh" type="MeshInstance3D" parent="Floor"]
mesh = PlaneMesh
size = Vector2(100, 100)

[node name="FloorCollision" type="CollisionShape3D" parent="Floor"]
shape = WorldBoundaryShape3D`
        : `[node name="Sprite" type="Sprite2D" parent="Player"]
texture = ExtResource("assets/sprites/player.png")

[node name="Collision" type="CollisionShape2D" parent="Player"]
shape = RectangleShape2D
size = Vector2(32, 32)

[node name="Camera" type="Camera2D" parent="Player"]
zoom = Vector2(2, 2)`
    }
\`\`\`

### Key rules:
- First node has no \`parent\` — it's the root
- \`parent="."\` means direct child of root
- \`parent="Player"\` means child of the Player node
- \`parent="Player/Head"\` means nested path
- Scripts attach via \`script = ExtResource("path")\`
- Resources via \`ExtResource("path")\` or inline`;
}
