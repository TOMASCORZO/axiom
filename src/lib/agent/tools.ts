/**
 * Axiom Agent — Tool Executor
 *
 * Real implementations for all 11 agent tools.
 * Each tool modifies project files in Supabase and returns structured results.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import type { ToolResult } from '@/types/agent';

type ToolInput = Record<string, unknown>;

interface ToolContext {
    supabase: SupabaseClient;
    projectId: string;
    userId: string;
}

// ── Scene File Format Helpers ──────────────────────────────────────

function generateSceneContent(
    sceneName: string,
    rootType: string,
    nodes: Array<{ type: string; name: string; props?: Record<string, unknown>; scriptPath?: string }> = [],
): string {
    let content = `[axiom_scene format=3]\n\n`;
    content += `[node name="${sceneName}" type="${rootType}"]\n\n`;

    for (const node of nodes) {
        content += `[node name="${node.name}" type="${node.type}" parent="."]\n`;
        if (node.scriptPath) {
            content += `script = ExtResource("${node.scriptPath}")\n`;
        }
        if (node.props) {
            for (const [key, value] of Object.entries(node.props)) {
                content += `${key} = ${JSON.stringify(value)}\n`;
            }
        }
        content += `\n`;
    }

    return content;
}

function generateScriptContent(
    extendsType: string,
    description: string,
    className?: string,
): string {
    const classLine = className ? `class_name ${className}\n` : '';
    return `# ${description}
extends ${extendsType}
${classLine}

func _ready():
\tpass # Initialize ${description.toLowerCase()}

func _process(delta):
\tpass # Update logic for ${description.toLowerCase()}
`;
}

// ── File Operations ────────────────────────────────────────────────

async function upsertProjectFile(
    ctx: ToolContext,
    path: string,
    content: string,
    contentType: string,
): Promise<void> {
    const { supabase, projectId } = ctx;

    // Check if file exists
    const { data: existing } = await supabase
        .from('project_files')
        .select('id')
        .eq('project_id', projectId)
        .eq('path', path)
        .single();

    if (existing) {
        await supabase
            .from('project_files')
            .update({
                text_content: content,
                content_type: contentType,
                size_bytes: new TextEncoder().encode(content).length,
                updated_at: new Date().toISOString(),
            })
            .eq('id', existing.id);
    } else {
        await supabase.from('project_files').insert({
            project_id: projectId,
            path,
            content_type: contentType,
            text_content: content,
            size_bytes: new TextEncoder().encode(content).length,
        });
    }
}

async function uploadBinaryAsset(
    ctx: ToolContext,
    path: string,
    buffer: ArrayBuffer,
    mimeType: string,
): Promise<string> {
    const { supabase, projectId, userId } = ctx;
    const storageKey = `projects/${userId}/${projectId}/${path}`;

    const { error } = await supabase.storage
        .from('assets')
        .upload(storageKey, buffer, {
            contentType: mimeType,
            upsert: true,
        });

    if (error) throw new Error(`Storage upload failed: ${error.message}`);

    // Also register in project_files
    await supabase.from('project_files').upsert({
        project_id: projectId,
        path,
        content_type: mimeType,
        size_bytes: buffer.byteLength,
        storage_key: storageKey,
    }, { onConflict: 'project_id,path' });

    return storageKey;
}

// ── Tool Implementations ───────────────────────────────────────────

export async function executeCreateScene(
    ctx: ToolContext,
    input: ToolInput,
): Promise<ToolResult> {
    const start = Date.now();
    const sceneName = input.scene_name as string;
    const rootType = input.root_node_type as string || 'Entity2D';
    const targetPath = input.target_path as string;

    const content = generateSceneContent(sceneName, rootType);
    await upsertProjectFile(ctx, targetPath, content, 'text/plain');

    return {
        callId: '',
        success: true,
        output: { message: `Scene "${sceneName}" created at ${targetPath}`, path: targetPath },
        filesModified: [targetPath],
        duration_ms: Date.now() - start,
    };
}

export async function executeWriteGameLogic(
    ctx: ToolContext,
    input: ToolInput,
): Promise<ToolResult> {
    const start = Date.now();
    const filePath = input.file_path as string;
    const description = input.description as string;
    const extendsType = input.extends_type as string || 'Entity2D';
    const existingContent = input.existing_content as string | undefined;
    const codeContent = input.code_content as string | undefined;

    // If Claude provides actual code, use it. Otherwise generate skeleton.
    const content = codeContent
        ?? existingContent
        ?? generateScriptContent(extendsType, description);

    await upsertProjectFile(ctx, filePath, content, 'text/plain');

    return {
        callId: '',
        success: true,
        output: { message: `Script written at ${filePath}`, path: filePath, lines: content.split('\n').length },
        filesModified: [filePath],
        duration_ms: Date.now() - start,
    };
}

export async function executeModifyScene(
    ctx: ToolContext,
    input: ToolInput,
): Promise<ToolResult> {
    const start = Date.now();
    const scenePath = input.scene_path as string;
    const operations = input.operations as Array<{
        action: string;
        target_node?: string;
        node_type?: string;
        node_name?: string;
        property?: string;
        value?: unknown;
        script_path?: string;
    }>;

    // Read current scene
    const { data: file } = await ctx.supabase
        .from('project_files')
        .select('text_content')
        .eq('project_id', ctx.projectId)
        .eq('path', scenePath)
        .single();

    let content = file?.text_content || generateSceneContent('Root', 'Entity2D');

    for (const op of operations) {
        switch (op.action) {
            case 'add_node':
                content += `[node name="${op.node_name}" type="${op.node_type}" parent="${op.target_node || '.'}"]\n`;
                if (op.script_path) {
                    content += `script = ExtResource("${op.script_path}")\n`;
                }
                content += '\n';
                break;
            case 'attach_script':
                content = content.replace(
                    new RegExp(`(\\[node name="${op.target_node}"[^\\]]*\\])`, 'g'),
                    `$1\nscript = ExtResource("${op.script_path}")`,
                );
                break;
            case 'modify_property':
                content = content.replace(
                    new RegExp(`(\\[node name="${op.target_node}"[^\\]]*\\]\\n)`, 'g'),
                    `$1${op.property} = ${JSON.stringify(op.value)}\n`,
                );
                break;
            case 'remove_node':
                content = content.replace(
                    new RegExp(`\\[node name="${op.target_node}"[^\\[]*`, 'g'),
                    '',
                );
                break;
        }
    }

    await upsertProjectFile(ctx, scenePath, content, 'text/plain');

    return {
        callId: '',
        success: true,
        output: {
            message: `Scene modified: ${operations.length} operations applied`,
            path: scenePath,
            operations: operations.map(o => `${o.action} ${o.node_name || o.target_node || ''}`),
        },
        filesModified: [scenePath],
        duration_ms: Date.now() - start,
    };
}

export async function executeModifyPhysics(
    ctx: ToolContext,
    input: ToolInput,
): Promise<ToolResult> {
    const start = Date.now();
    const scenePath = input.scene_path as string;
    const nodeName = input.node_name as string;
    const physicsType = input.physics_type as string;
    const collisionShape = input.collision_shape as string | undefined;
    const properties = input.properties as Record<string, unknown> | undefined;

    // Map physics types to engine node types
    const bodyType: Record<string, string> = {
        static: 'StaticBody2D',
        rigid: 'RigidBody2D',
        kinematic: 'CharacterBody2D',
        area: 'Area2D',
    };

    const shapeType: Record<string, string> = {
        rectangle: 'RectangleShape2D',
        circle: 'CircleShape2D',
        capsule: 'CapsuleShape2D',
        polygon: 'ConvexPolygonShape2D',
    };

    const ops = [
        {
            action: 'add_node' as const,
            node_name: `${nodeName}_body`,
            node_type: bodyType[physicsType] || 'RigidBody2D',
            target_node: nodeName,
        },
    ];

    if (collisionShape) {
        ops.push({
            action: 'add_node' as const,
            node_name: `${nodeName}_collision`,
            node_type: 'CollisionShape2D',
            target_node: `${nodeName}_body`,
        });
    }

    const result = await executeModifyScene(ctx, {
        scene_path: scenePath,
        operations: ops,
    });

    // If extra properties, append them
    if (properties && Object.keys(properties).length > 0) {
        const propsStr = Object.entries(properties)
            .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
            .join('\n');

        const { data: file } = await ctx.supabase
            .from('project_files')
            .select('text_content')
            .eq('project_id', ctx.projectId)
            .eq('path', scenePath)
            .single();

        if (file?.text_content) {
            const content = file.text_content + `\n# Physics properties for ${nodeName}\n${propsStr}\n`;
            await upsertProjectFile(ctx, scenePath, content, 'text/plain');
        }
    }

    return {
        ...result,
        output: {
            message: `Physics configured: ${physicsType} body + ${collisionShape || 'no shape'} on "${nodeName}"`,
            path: scenePath,
        },
        duration_ms: Date.now() - start,
    };
}

export async function executeUpdateUILayout(
    ctx: ToolContext,
    input: ToolInput,
): Promise<ToolResult> {
    const start = Date.now();
    const scenePath = input.scene_path as string;
    const operations = input.operations as Array<{
        action: string;
        element_type?: string;
        element_name?: string;
        property?: string;
        value?: unknown;
    }>;

    const sceneOps = operations.map(op => {
        switch (op.action) {
            case 'add_element':
                return {
                    action: 'add_node' as const,
                    node_name: op.element_name || 'UIElement',
                    node_type: op.element_type || 'Control',
                };
            case 'remove_element':
                return { action: 'remove_node' as const, target_node: op.element_name };
            case 'modify_style':
            case 'set_text':
                return {
                    action: 'modify_property' as const,
                    target_node: op.element_name,
                    property: op.property || 'text',
                    value: op.value,
                };
            default:
                return { action: 'add_node' as const, node_name: 'unknown', node_type: 'Control' };
        }
    });

    return executeModifyScene(ctx, { scene_path: scenePath, operations: sceneOps });
}

export async function executeDebugRuntimeError(
    ctx: ToolContext,
    input: ToolInput,
): Promise<ToolResult> {
    const start = Date.now();
    const errorMessage = input.error_message as string;
    const errorFile = input.error_file as string;
    const errorLine = input.error_line as number;

    // Read the offending file
    const { data: file } = await ctx.supabase
        .from('project_files')
        .select('text_content')
        .eq('project_id', ctx.projectId)
        .eq('path', errorFile)
        .single();

    const diagnosis = {
        error: errorMessage,
        file: errorFile,
        line: errorLine,
        fileContent: file?.text_content || '(file not found)',
        suggestion: `Error on line ${errorLine}: ${errorMessage}. The agent should analyze the code and suggest a fix.`,
    };

    return {
        callId: '',
        success: true,
        output: diagnosis,
        filesModified: [],
        duration_ms: Date.now() - start,
    };
}

export async function executeExportBuild(
    ctx: ToolContext,
    input: ToolInput,
): Promise<ToolResult> {
    const start = Date.now();
    const platform = input.platform as string || 'web';

    // Queue a build in the builds table
    const { data: build, error } = await ctx.supabase
        .from('builds')
        .insert({
            project_id: ctx.projectId,
            platform,
            status: 'queued',
            log: `Build queued for ${platform} at ${new Date().toISOString()}`,
        })
        .select()
        .single();

    if (error) throw new Error(`Failed to queue build: ${error.message}`);

    return {
        callId: '',
        success: true,
        output: {
            message: `Build queued for ${platform}`,
            build_id: build?.id,
            status: 'queued',
            note: 'Build will be processed by the build worker pipeline',
        },
        filesModified: [],
        duration_ms: Date.now() - start,
    };
}

// ── Asset Generation (calls external APIs) ─────────────────────────

export async function executeGenerateSprite(
    ctx: ToolContext,
    input: ToolInput,
): Promise<ToolResult> {
    const start = Date.now();
    const prompt = input.prompt as string;
    const style = input.style as string || 'stylized';
    const width = input.width as number || 128;
    const height = input.height as number || 128;
    const transparentBg = input.transparent_bg as boolean ?? true;
    const targetPath = input.target_path as string;

    const imageBuffer = await generateImage({
        prompt: `Game sprite: ${prompt}. Style: ${style}. ${transparentBg ? 'Transparent background.' : ''} ${width}x${height}px.`,
        width,
        height,
        model: 'sprite',
    });

    if (imageBuffer) {
        const storageKey = await uploadBinaryAsset(ctx, targetPath, imageBuffer, 'image/png');

        // Register asset
        await ctx.supabase.from('assets').insert({
            project_id: ctx.projectId,
            name: targetPath.split('/').pop() || 'sprite',
            asset_type: 'sprite',
            storage_key: storageKey,
            file_format: 'png',
            width,
            height,
            generation_prompt: prompt,
            generation_model: 'openai-dall-e-3',
            size_bytes: imageBuffer.byteLength,
            metadata: { style, transparent_bg: transparentBg },
        });

        return {
            callId: '',
            success: true,
            output: { message: `Sprite generated at ${targetPath}`, path: targetPath, storageKey, size: imageBuffer.byteLength },
            filesModified: [targetPath],
            duration_ms: Date.now() - start,
        };
    }

    // Fallback: create a placeholder SVG
    const placeholderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="${transparentBg ? 'none' : '#1a1a2e'}"/>
<rect x="10%" y="10%" width="80%" height="80%" rx="8" fill="#8b5cf6" opacity="0.3"/>
<text x="50%" y="50%" text-anchor="middle" dy=".3em" fill="#fff" font-size="12" font-family="sans-serif">${prompt.slice(0, 20)}</text>
</svg>`;

    await upsertProjectFile(ctx, targetPath, placeholderSvg, 'image/svg+xml');

    return {
        callId: '',
        success: true,
        output: {
            message: `Placeholder sprite created at ${targetPath} (no image API key configured)`,
            path: targetPath,
            placeholder: true,
        },
        filesModified: [targetPath],
        duration_ms: Date.now() - start,
    };
}

export async function executeGenerateTexture(
    ctx: ToolContext,
    input: ToolInput,
): Promise<ToolResult> {
    const start = Date.now();
    const prompt = input.prompt as string;
    const style = input.style as string || 'stylized';
    const width = input.width as number || 512;
    const height = input.height as number || 512;
    const tileable = input.tileable as boolean || false;
    const targetPath = input.target_path as string;

    const imageBuffer = await generateImage({
        prompt: `Seamless game texture: ${prompt}. Style: ${style}. ${tileable ? 'Tileable/seamless pattern.' : ''} ${width}x${height}px.`,
        width,
        height,
        model: 'texture',
    });

    if (imageBuffer) {
        const storageKey = await uploadBinaryAsset(ctx, targetPath, imageBuffer, 'image/png');

        await ctx.supabase.from('assets').insert({
            project_id: ctx.projectId,
            name: targetPath.split('/').pop() || 'texture',
            asset_type: 'texture',
            storage_key: storageKey,
            file_format: 'png',
            width,
            height,
            generation_prompt: prompt,
            generation_model: 'openai-dall-e-3',
            size_bytes: imageBuffer.byteLength,
            metadata: { style, tileable },
        });

        return {
            callId: '',
            success: true,
            output: { message: `Texture generated at ${targetPath}`, path: targetPath, storageKey },
            filesModified: [targetPath],
            duration_ms: Date.now() - start,
        };
    }

    // Fallback placeholder
    await upsertProjectFile(ctx, targetPath, `# Placeholder texture: ${prompt}\n# Configure OPENAI_API_KEY to generate real textures`, 'text/plain');

    return {
        callId: '',
        success: true,
        output: { message: `Placeholder texture at ${targetPath}`, path: targetPath, placeholder: true },
        filesModified: [targetPath],
        duration_ms: Date.now() - start,
    };
}

export async function executeGenerate3DModel(
    ctx: ToolContext,
    input: ToolInput,
): Promise<ToolResult> {
    const start = Date.now();
    const prompt = input.prompt as string;
    const targetPath = input.target_path as string;

    const meshyKey = process.env.MESHY_API_KEY;

    if (meshyKey) {
        try {
            // Call Meshy API for 3D generation
            const createRes = await fetch('https://api.meshy.ai/v2/text-to-3d', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${meshyKey}`,
                },
                body: JSON.stringify({
                    mode: 'preview',
                    prompt,
                    art_style: 'game-asset',
                    topology: 'quad',
                }),
            });

            if (createRes.ok) {
                const { result: taskId } = await createRes.json() as { result: string };

                // Poll for completion (max 60 seconds)
                let modelUrl: string | null = null;
                for (let i = 0; i < 30; i++) {
                    await new Promise(r => setTimeout(r, 2000));
                    const statusRes = await fetch(`https://api.meshy.ai/v2/text-to-3d/${taskId}`, {
                        headers: { 'Authorization': `Bearer ${meshyKey}` },
                    });
                    if (statusRes.ok) {
                        const status = await statusRes.json() as { status: string; model_urls?: { glb?: string } };
                        if (status.status === 'SUCCEEDED' && status.model_urls?.glb) {
                            modelUrl = status.model_urls.glb;
                            break;
                        }
                        if (status.status === 'FAILED') break;
                    }
                }

                if (modelUrl) {
                    const modelRes = await fetch(modelUrl);
                    const buffer = await modelRes.arrayBuffer();
                    const storageKey = await uploadBinaryAsset(ctx, targetPath, buffer, 'model/gltf-binary');

                    await ctx.supabase.from('assets').insert({
                        project_id: ctx.projectId,
                        name: targetPath.split('/').pop() || 'model',
                        asset_type: 'model_3d',
                        storage_key: storageKey,
                        file_format: 'glb',
                        generation_prompt: prompt,
                        generation_model: 'meshy-v2',
                        size_bytes: buffer.byteLength,
                        metadata: { task_id: taskId },
                    });

                    return {
                        callId: '',
                        success: true,
                        output: { message: `3D model generated at ${targetPath}`, path: targetPath, storageKey },
                        filesModified: [targetPath],
                        duration_ms: Date.now() - start,
                    };
                }
            }
        } catch (err) {
            // Fall through to placeholder
            console.error('Meshy API error:', err);
        }
    }

    // Fallback: create a placeholder .res file
    const placeholder = `# 3D Model placeholder: ${prompt}\n# Configure MESHY_API_KEY for real 3D generation\n[resource]\ntype = "PrimitiveMesh"\nprimitive = "Box"`;
    await upsertProjectFile(ctx, targetPath.replace('.glb', '.res'), placeholder, 'text/plain');

    return {
        callId: '',
        success: true,
        output: { message: `Placeholder 3D model at ${targetPath}`, path: targetPath, placeholder: true },
        filesModified: [targetPath],
        duration_ms: Date.now() - start,
    };
}

export async function executeGenerateAnimation(
    ctx: ToolContext,
    input: ToolInput,
): Promise<ToolResult> {
    const start = Date.now();
    const type = input.type as string || 'sprite_frames';
    const frameCount = input.frame_count as number || 4;
    const fps = input.fps as number || 12;
    const loop = input.loop as boolean || true;
    const targetPath = input.target_path as string;

    // Generate animation resource file
    const animContent = `[axiom_resource format=3]

[resource type="SpriteFrames"]
animations = [{
\t"frames": [],
\t"loop": ${loop},
\t"name": &"default",
\t"speed": ${fps}.0
}]
# Animation type: ${type}
# Frame count: ${frameCount}
# FPS: ${fps}
`;

    await upsertProjectFile(ctx, targetPath, animContent, 'text/plain');

    return {
        callId: '',
        success: true,
        output: {
            message: `Animation resource created at ${targetPath} (${type}, ${frameCount} frames, ${fps} FPS)`,
            path: targetPath,
        },
        filesModified: [targetPath],
        duration_ms: Date.now() - start,
    };
}

// ── Image Generation API ───────────────────────────────────────────

interface ImageGenParams {
    prompt: string;
    width: number;
    height: number;
    model: 'sprite' | 'texture';
}

async function generateImage(params: ImageGenParams): Promise<ArrayBuffer | null> {
    // Try OpenAI DALL-E 3
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
        try {
            const size = params.width <= 256 && params.height <= 256
                ? '256x256' as const
                : params.width <= 512 && params.height <= 512
                    ? '512x512' as const
                    : '1024x1024' as const;

            const res = await fetch('https://api.openai.com/v1/images/generations', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiKey}`,
                },
                body: JSON.stringify({
                    model: 'dall-e-3',
                    prompt: params.prompt,
                    n: 1,
                    size,
                    response_format: 'b64_json',
                }),
            });

            if (res.ok) {
                const data = await res.json() as { data: Array<{ b64_json: string }> };
                const b64 = data.data[0]?.b64_json;
                if (b64) {
                    const binary = atob(b64);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) {
                        bytes[i] = binary.charCodeAt(i);
                    }
                    return bytes.buffer;
                }
            }
        } catch (err) {
            console.error('OpenAI image generation failed:', err);
        }
    }

    // Try FLUX via fal.ai
    const fluxKey = process.env.FLUX_API_KEY;
    if (fluxKey) {
        try {
            const res = await fetch('https://fal.run/fal-ai/flux/dev', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Key ${fluxKey}`,
                },
                body: JSON.stringify({
                    prompt: params.prompt,
                    image_size: { width: params.width, height: params.height },
                    num_images: 1,
                }),
            });

            if (res.ok) {
                const data = await res.json() as { images: Array<{ url: string }> };
                const imageUrl = data.images?.[0]?.url;
                if (imageUrl) {
                    const imgRes = await fetch(imageUrl);
                    return imgRes.arrayBuffer();
                }
            }
        } catch (err) {
            console.error('FLUX image generation failed:', err);
        }
    }

    return null;
}

// ── Project Configuration ──────────────────────────────────────────

export async function executeCreateProjectConfig(
    ctx: ToolContext,
    input: ToolInput,
): Promise<ToolResult> {
    const start = Date.now();
    const projectName = input.project_name as string || 'My Game';
    const mainScene = input.main_scene as string || 'scenes/main.scene';
    const displayWidth = input.display_width as number || 1280;
    const displayHeight = input.display_height as number || 720;
    const gameMode = input.game_mode as string || '2d';
    const is3D = gameMode === '3d';

    const configContent = `; Axiom Engine Project Configuration
; Generated by Axiom AI Agent

[application]
config/name="${projectName}"
run/main_scene="res://${mainScene}"
config/features=PackedStringArray("${is3D ? '3D' : '2D'}")

[display]
window/size/viewport_width=${displayWidth}
window/size/viewport_height=${displayHeight}
window/stretch/mode="canvas_items"
${is3D ? 'window/stretch/aspect="expand"' : 'window/stretch/aspect="keep"'}

[input]
ui_accept={
"events": [Object(InputEventKey,"keycode":4194309)]
}
ui_left={
"events": [Object(InputEventKey,"keycode":4194319), Object(InputEventKey,"keycode":65)]
}
ui_right={
"events": [Object(InputEventKey,"keycode":4194321), Object(InputEventKey,"keycode":68)]
}
ui_up={
"events": [Object(InputEventKey,"keycode":4194320), Object(InputEventKey,"keycode":87)]
}
ui_down={
"events": [Object(InputEventKey,"keycode":4194322), Object(InputEventKey,"keycode":83)]
}

[physics]
${is3D ? '3d/default_gravity=9.8\n3d/default_gravity_vector=Vector3(0, -1, 0)' : '2d/default_gravity=980.0\n2d/default_gravity_vector=Vector2(0, 1)'}

[rendering]
${is3D ? 'renderer/rendering_method="forward_plus"\nenvironment/defaults/default_environment="res://default_env.tres"' : 'renderer/rendering_method="gl_compatibility"\ntextures/canvas_textures/default_texture_filter=0'}
`;

    await upsertProjectFile(ctx, 'project.axiom', configContent, 'text/plain');

    return {
        callId: '',
        success: true,
        output: {
            message: `Project config created: ${projectName} (${is3D ? '3D' : '2D'}, ${displayWidth}x${displayHeight})`,
            path: 'project.axiom',
            mainScene,
        },
        filesModified: ['project.axiom'],
        duration_ms: Date.now() - start,
    };
}

// ── Master Dispatcher ──────────────────────────────────────────────

export async function dispatchTool(
    toolName: string,
    input: ToolInput,
    ctx: ToolContext,
): Promise<ToolResult> {
    const handlers: Record<string, (ctx: ToolContext, input: ToolInput) => Promise<ToolResult>> = {
        create_scene: executeCreateScene,
        write_game_logic: executeWriteGameLogic,
        modify_scene: executeModifyScene,
        modify_physics: executeModifyPhysics,
        update_ui_layout: executeUpdateUILayout,
        debug_runtime_error: executeDebugRuntimeError,
        export_build: executeExportBuild,
        generate_sprite: executeGenerateSprite,
        generate_texture: executeGenerateTexture,
        generate_3d_model: executeGenerate3DModel,
        generate_animation: executeGenerateAnimation,
        create_project_config: executeCreateProjectConfig,
    };

    const handler = handlers[toolName];
    if (!handler) {
        return {
            callId: '',
            success: false,
            output: {},
            filesModified: [],
            error: `Unknown tool: ${toolName}`,
            duration_ms: 0,
        };
    }

    try {
        const result = await handler(ctx, input);
        return result;
    } catch (error) {
        return {
            callId: '',
            success: false,
            output: {},
            filesModified: [],
            error: error instanceof Error ? error.message : 'Tool execution failed',
            duration_ms: 0,
        };
    }
}
