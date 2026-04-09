/**
 * Game Tools — the original Axiom game-specific tools.
 * Registers all 13 game tools (scene, script, physics, assets, etc.)
 * into the unified registry.
 */

import { getAdminClient as getAdmin } from '@/lib/supabase/admin';
import type { ToolResult, ToolFileData } from '@/types/agent';
import { registerTool, type ToolContext, type ToolInput } from './registry';

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
        if (node.scriptPath) content += `script = ExtResource("${node.scriptPath}")\n`;
        if (node.props) {
            for (const [key, value] of Object.entries(node.props)) {
                content += `${key} = ${JSON.stringify(value)}\n`;
            }
        }
        content += `\n`;
    }
    return content;
}

// ── File Operations ────────────────────────────────────────────────

async function upsertProjectFile(ctx: ToolContext, path: string, content: string, contentType: string): Promise<void> {
    const sizeBytes = new TextEncoder().encode(content).length;
    ctx.createdFiles.push({ path, content, size_bytes: sizeBytes, content_type: contentType });
    try {
        const admin = getAdmin();
        const { error } = await admin.from('project_files').upsert({
            project_id: ctx.projectId, path,
            content_type: contentType === 'text' ? 'text' : 'binary',
            text_content: content, size_bytes: sizeBytes,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'project_id,path' }).select('id');
        if (error) console.error(`[axiom] File write failed for ${path}:`, error.message);
    } catch { /* */ }
}

async function uploadBinaryAsset(ctx: ToolContext, path: string, buffer: ArrayBuffer, mimeType: string): Promise<string> {
    const storageKey = `projects/${ctx.userId}/${ctx.projectId}/${path}`;
    try {
        const admin = getAdmin();
        const { error } = await admin.storage.from('assets').upload(storageKey, buffer, { contentType: mimeType, upsert: true });
        if (error) console.error(`[axiom] Storage upload failed for ${path}:`, error.message);
        admin.from('project_files').upsert({
            project_id: ctx.projectId, path, content_type: 'binary',
            size_bytes: buffer.byteLength, storage_key: storageKey,
        }, { onConflict: 'project_id,path' }).then(({ error: e }) => {
            if (e) console.error(`[axiom] File registration failed for ${path}:`, e.message);
        });
    } catch (e) { console.error(`[axiom] Upload failed for ${path}:`, e); }
    return storageKey;
}

// ── Image / 3D Generation (via fal.ai) ─────────────────────────────

import { generate2D, generate3D, generateAnimation, img2img, downloadResult, removeBackground, type Model2D, type Provider } from '@/lib/assets/generate';

async function generateImage(params: { prompt: string; width: number; height: number; style?: string; model_2d?: string; provider?: string; loras?: Array<{ url: string; scale?: number }> }): Promise<{ buffer: ArrayBuffer } | { error: string }> {
    const model: Model2D = (params.model_2d as Model2D) || (process.env.REPLICATE_API_TOKEN ? 'flux-schnell' : 'sdxl');
    const provider = params.provider as Provider | undefined;
    const result = await generate2D({
        prompt: params.prompt,
        model,
        provider,
        width: params.width,
        height: params.height,
        style: params.style,
        format: 'png',
        loras: params.loras,
    });
    if (result.success && result.imageUrl) {
        try {
            const buffer = await downloadResult(result.imageUrl);
            return { buffer };
        } catch (err) {
            return { error: `Download failed: ${err instanceof Error ? err.message : 'unknown'}` };
        }
    }
    return { error: result.error || `Generation failed (provider: ${result.provider}, model: ${result.model})` };
}

// ── Free Asset Search (shared module) ─────────────────────────────

import { searchKenney, searchOpenGameArt, searchItchIo, type FreeAssetResult } from '@/lib/assets/search';

// ── Register All Game Tools ────────────────────────────────────────

registerTool({
    name: 'create_scene',
    description: 'Create a new .scene file with a root node',
    parameters: {
        type: 'object',
        properties: {
            scene_name: { type: 'string', description: 'Name of the scene file (without extension)' },
            root_node_type: { type: 'string', description: 'Root node type (e.g. Entity2D, Entity3D, Control)', default: 'Entity2D' },
            target_path: { type: 'string', description: 'Path in project, e.g. scenes/main.scene' },
        },
        required: ['scene_name', 'target_path'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const sceneName = input.scene_name as string;
        const rootType = (input.root_node_type as string) || 'Entity2D';
        const targetPath = input.target_path as string;
        const content = generateSceneContent(sceneName, rootType);
        await upsertProjectFile(ctx, targetPath, content, 'text');
        return { callId: '', success: true, output: { message: `Scene "${sceneName}" created at ${targetPath}`, path: targetPath }, filesModified: [targetPath], duration_ms: Date.now() - start };
    },
});

registerTool({
    name: 'write_game_logic',
    description: 'Write or modify an AxiomScript (.axs) file. Always provide the FULL code in code_content.',
    parameters: {
        type: 'object',
        properties: {
            file_path: { type: 'string', description: 'Script path, e.g. scripts/player.axs' },
            description: { type: 'string', description: 'What the script should do' },
            code_content: { type: 'string', description: 'The full AxiomScript code to write' },
            extends_type: { type: 'string', default: 'Entity2D', description: 'Base class to extend' },
        },
        required: ['file_path', 'description', 'code_content'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const filePath = input.file_path as string;
        const content = (input.code_content as string) || `# ${input.description}\nextends ${input.extends_type || 'Entity2D'}\n\nfunc _ready():\n\tpass\n`;
        await upsertProjectFile(ctx, filePath, content, 'text');
        return { callId: '', success: true, output: { message: `Script written at ${filePath}`, path: filePath, lines: content.split('\n').length }, filesModified: [filePath], duration_ms: Date.now() - start };
    },
});

registerTool({
    name: 'modify_scene',
    description: 'Add, remove, or modify nodes in a scene file',
    parameters: {
        type: 'object',
        properties: {
            scene_path: { type: 'string', description: 'Path to the .scene file' },
            operations: { type: 'array', items: { type: 'object', properties: { action: { type: 'string', enum: ['add_node', 'remove_node', 'modify_property', 'attach_script'] }, target_node: { type: 'string' }, node_type: { type: 'string' }, node_name: { type: 'string' }, property: { type: 'string' }, value: {}, script_path: { type: 'string' } }, required: ['action'] } },
        },
        required: ['scene_path', 'operations'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const scenePath = input.scene_path as string;
        const operations = input.operations as Array<{ action: string; target_node?: string; node_type?: string; node_name?: string; property?: string; value?: unknown; script_path?: string }>;
        const { data: file } = await getAdmin().from('project_files').select('text_content').eq('project_id', ctx.projectId).eq('path', scenePath).single();
        let content = file?.text_content || generateSceneContent('Root', 'Entity2D');
        for (const op of operations) {
            switch (op.action) {
                case 'add_node':
                    content += `[node name="${op.node_name}" type="${op.node_type}" parent="${op.target_node || '.'}"]\n`;
                    if (op.script_path) content += `script = ExtResource("${op.script_path}")\n`;
                    content += '\n';
                    break;
                case 'attach_script':
                    content = content.replace(new RegExp(`(\\[node name="${op.target_node}"[^\\]]*\\])`, 'g'), `$1\nscript = ExtResource("${op.script_path}")`);
                    break;
                case 'modify_property':
                    content = content.replace(new RegExp(`(\\[node name="${op.target_node}"[^\\]]*\\]\\n)`, 'g'), `$1${op.property} = ${JSON.stringify(op.value)}\n`);
                    break;
                case 'remove_node':
                    content = content.replace(new RegExp(`\\[node name="${op.target_node}"[^\\[]*`, 'g'), '');
                    break;
            }
        }
        await upsertProjectFile(ctx, scenePath, content, 'text');
        return { callId: '', success: true, output: { message: `Scene modified: ${operations.length} operations`, path: scenePath, operations: operations.map(o => `${o.action} ${o.node_name || o.target_node || ''}`) }, filesModified: [scenePath], duration_ms: Date.now() - start };
    },
});

registerTool({
    name: 'modify_physics',
    description: 'Configure physics properties on scene nodes',
    parameters: {
        type: 'object',
        properties: { scene_path: { type: 'string' }, node_name: { type: 'string' }, physics_type: { type: 'string', enum: ['static', 'rigid', 'kinematic', 'area'] }, collision_shape: { type: 'string', enum: ['rectangle', 'circle', 'capsule', 'polygon'] }, properties: { type: 'object' } },
        required: ['scene_path', 'node_name', 'physics_type'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const scenePath = input.scene_path as string;
        const nodeName = input.node_name as string;
        const physicsType = input.physics_type as string;
        const collisionShape = input.collision_shape as string | undefined;
        const bodyType: Record<string, string> = { static: 'StaticBody2D', rigid: 'RigidBody2D', kinematic: 'CharacterBody2D', area: 'Area2D' };
        const ops: Array<{ action: string; node_name: string; node_type: string; target_node: string }> = [
            { action: 'add_node', node_name: `${nodeName}_body`, node_type: bodyType[physicsType] || 'RigidBody2D', target_node: nodeName },
        ];
        if (collisionShape) ops.push({ action: 'add_node', node_name: `${nodeName}_collision`, node_type: 'CollisionShape2D', target_node: `${nodeName}_body` });
        // Reuse modify_scene logic
        const { data: file } = await getAdmin().from('project_files').select('text_content').eq('project_id', ctx.projectId).eq('path', scenePath).single();
        let content = file?.text_content || generateSceneContent('Root', 'Entity2D');
        for (const op of ops) { content += `[node name="${op.node_name}" type="${op.node_type}" parent="${op.target_node}"]\n\n`; }
        await upsertProjectFile(ctx, scenePath, content, 'text');
        return { callId: '', success: true, output: { message: `Physics: ${physicsType} + ${collisionShape || 'no shape'} on "${nodeName}"`, path: scenePath }, filesModified: [scenePath], duration_ms: Date.now() - start };
    },
});

registerTool({
    name: 'update_ui_layout',
    description: 'Modify UI scene elements (layout, styling, text)',
    parameters: {
        type: 'object',
        properties: { scene_path: { type: 'string' }, operations: { type: 'array', items: { type: 'object', properties: { action: { type: 'string', enum: ['add_element', 'remove_element', 'modify_style', 'set_text'] }, element_type: { type: 'string' }, element_name: { type: 'string' }, property: { type: 'string' }, value: {} }, required: ['action'] } } },
        required: ['scene_path', 'operations'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const scenePath = input.scene_path as string;
        const operations = input.operations as Array<{ action: string; element_type?: string; element_name?: string; property?: string; value?: unknown }>;
        const { data: file } = await getAdmin().from('project_files').select('text_content').eq('project_id', ctx.projectId).eq('path', scenePath).single();
        let content = file?.text_content || generateSceneContent('UI', 'Control');
        for (const op of operations) {
            if (op.action === 'add_element') content += `[node name="${op.element_name || 'UIElement'}" type="${op.element_type || 'Control'}" parent="."]\n\n`;
            else if (op.action === 'remove_element') content = content.replace(new RegExp(`\\[node name="${op.element_name}"[^\\[]*`, 'g'), '');
            else if (op.action === 'modify_style' || op.action === 'set_text') content = content.replace(new RegExp(`(\\[node name="${op.element_name}"[^\\]]*\\]\\n)`, 'g'), `$1${op.property || 'text'} = ${JSON.stringify(op.value)}\n`);
        }
        await upsertProjectFile(ctx, scenePath, content, 'text');
        return { callId: '', success: true, output: { message: `UI modified: ${operations.length} ops`, path: scenePath }, filesModified: [scenePath], duration_ms: Date.now() - start };
    },
});

registerTool({
    name: 'debug_runtime_error',
    description: 'Analyze a runtime error and generate a fix',
    parameters: {
        type: 'object',
        properties: { error_message: { type: 'string' }, error_file: { type: 'string' }, error_line: { type: 'integer' }, stack_trace: { type: 'string' } },
        required: ['error_message', 'error_file', 'error_line'],
    },
    access: ['build', 'plan'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const { data: file } = await getAdmin().from('project_files').select('text_content').eq('project_id', ctx.projectId).eq('path', input.error_file as string).single();
        return { callId: '', success: true, output: { error: input.error_message, file: input.error_file, line: input.error_line, fileContent: file?.text_content || '(not found)', suggestion: `Analyze and fix.` }, filesModified: [], duration_ms: Date.now() - start };
    },
});

registerTool({
    name: 'export_build',
    description: 'Export the project as a playable build',
    parameters: { type: 'object', properties: { platform: { type: 'string', enum: ['web', 'windows', 'linux', 'macos', 'android'], default: 'web' }, optimize: { type: 'boolean', default: true } }, required: ['platform'] },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const platform = (input.platform as string) || 'web';
        const { data: build, error } = await getAdmin().from('builds').insert({ project_id: ctx.projectId, platform, status: 'queued', log: `Build queued for ${platform}` }).select().single();
        if (error) throw new Error(`Build queue failed: ${error.message}`);
        return { callId: '', success: true, output: { message: `Build queued for ${platform}`, build_id: build?.id, status: 'queued' }, filesModified: [], duration_ms: Date.now() - start };
    },
});

registerTool({
    name: 'search_free_asset',
    description: 'Search open-source asset libraries (OpenGameArt, Kenney, itch.io) for free game assets. Costs 0 credits. PREFER this over generate_sprite/generate_texture.',
    parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, asset_type: { type: 'string', enum: ['sprite', 'texture', 'tileset', 'sprite_sheet', 'background', 'icon', 'sound', 'model_3d'] }, target_path: { type: 'string' }, max_results: { type: 'integer', default: 5 } },
        required: ['query', 'asset_type', 'target_path'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const query = input.query as string;
        const assetType = input.asset_type as string;
        const targetPath = input.target_path as string;
        const [kenneyResults, ogaResults, itchResults] = await Promise.all([
            Promise.resolve(searchKenney(query, assetType)),
            searchOpenGameArt(query, assetType),
            searchItchIo(query),
        ]);
        const all = [...kenneyResults.map(r => ({ ...r, priority: 0 })), ...ogaResults.map(r => ({ ...r, priority: 1 })), ...itchResults.map(r => ({ ...r, priority: 2 }))].sort((a, b) => a.priority - b.priority).slice(0, 5);
        let downloaded = false;
        const best = all[0];
        if (best && (best.download_url || best.preview_url)) {
            try {
                const imgRes = await fetch((best.preview_url || best.download_url)!, { signal: AbortSignal.timeout(10000) });
                if (imgRes.ok) { const buf = await imgRes.arrayBuffer(); if (buf.byteLength > 0 && buf.byteLength < 10 * 1024 * 1024) { await uploadBinaryAsset(ctx, targetPath, buf, imgRes.headers.get('content-type') || 'image/png'); downloaded = true; } }
            } catch { /* */ }
        }
        return { callId: '', success: true, output: { message: downloaded ? `Asset "${best.title}" from ${best.source} → ${targetPath}` : `Found ${all.length} assets for "${query}"`, downloaded, results: all.map(r => ({ title: r.title, url: r.url, source: r.source, license: r.license })) }, filesModified: downloaded ? [targetPath] : [], duration_ms: Date.now() - start };
    },
});

registerTool({
    name: 'generate_sprite',
    description: 'AI-generate a CUSTOM 2D sprite image, or create a variation via img2img when source_image_url is provided.',
    parameters: {
        type: 'object',
        properties: {
            prompt: { type: 'string' },
            style: { type: 'string', enum: ['pixel_art', 'hand_drawn', 'vector', 'realistic', 'stylized'], default: 'stylized' },
            width: { type: 'integer', default: 128 },
            height: { type: 'integer', default: 128 },
            transparent_bg: { type: 'boolean', default: true },
            target_path: { type: 'string' },
            source_image_url: { type: 'string', description: 'Source image URL for img2img variation' },
            strength: { type: 'number', description: 'Img2img strength 0.0-1.0 (lower = closer to original)', default: 0.5 },
        },
        required: ['prompt', 'target_path'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const prompt = input.prompt as string;
        const width = (input.width as number) || 128;
        const height = (input.height as number) || 128;
        const targetPath = input.target_path as string;
        const style = input.style as string | undefined;
        const model2d = input.model_2d as string | undefined;
        const prov = input.provider as string | undefined;
        const loras = input.loras as Array<{ url: string; scale?: number }> | undefined;
        const sourceImageUrl = input.source_image_url as string | undefined;
        const strength = input.strength as number | undefined;

        let result: { buffer: ArrayBuffer } | { error: string };

        if (sourceImageUrl) {
            // Img2Img mode — generate variation from source image
            const i2iResult = await img2img({
                imageUrl: sourceImageUrl,
                prompt,
                model: (model2d as Model2D) || undefined,
                provider: (prov as Provider) || undefined,
                strength: strength ?? 0.5,
                width, height, style, format: 'png',
            });
            if (i2iResult.success && i2iResult.imageUrl) {
                try {
                    const buffer = await downloadResult(i2iResult.imageUrl);
                    result = { buffer };
                } catch (err) {
                    result = { error: `Download failed: ${err instanceof Error ? err.message : 'unknown'}` };
                }
            } else {
                result = { error: i2iResult.error || 'Img2Img failed' };
            }
        } else {
            // Text-to-image mode
            result = await generateImage({ prompt: `Game sprite: ${prompt}`, width, height, style, model_2d: model2d, provider: prov, loras });
        }

        if ('buffer' in result) {
            let finalBuffer = result.buffer;

            // Remove background for guaranteed transparency (default: true)
            const wantTransparent = input.transparent_bg !== false;
            if (wantTransparent) {
                const bgResult = await removeBackground(finalBuffer);
                if (bgResult.success && bgResult.buffer) {
                    finalBuffer = bgResult.buffer;
                } else {
                    console.warn('[axiom] Background removal failed, using original:', bgResult.error);
                }
            }

            const sk = await uploadBinaryAsset(ctx, targetPath, finalBuffer, 'image/png');
            return { callId: '', success: true, output: { message: `Sprite generated at ${targetPath}`, path: targetPath, storage_key: sk }, filesModified: [targetPath], duration_ms: Date.now() - start };
        }
        return { callId: '', success: false, output: { message: result.error }, error: result.error, filesModified: [], duration_ms: Date.now() - start };
    },
});

registerTool({
    name: 'generate_texture',
    description: 'AI-generate a texture. Costs 5 credits.',
    parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' }, style: { type: 'string', enum: ['pbr', 'stylized', 'pixel', 'hand_painted'], default: 'stylized' }, width: { type: 'integer', default: 512 }, height: { type: 'integer', default: 512 }, tileable: { type: 'boolean', default: false }, target_path: { type: 'string' } },
        required: ['prompt', 'target_path'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const prompt = input.prompt as string;
        const width = (input.width as number) || 512;
        const height = (input.height as number) || 512;
        const targetPath = input.target_path as string;
        const tStyle = input.style as string | undefined;
        const tModel = input.model_2d as string | undefined;
        const tProv = input.provider as string | undefined;
        const tLoras = input.loras as Array<{ url: string; scale?: number }> | undefined;
        const result = await generateImage({ prompt: `Seamless game texture: ${prompt}`, width, height, style: tStyle, model_2d: tModel, provider: tProv, loras: tLoras });
        if ('buffer' in result) {
            const sk = await uploadBinaryAsset(ctx, targetPath, result.buffer, 'image/png');
            return { callId: '', success: true, output: { message: `Texture at ${targetPath}`, path: targetPath, storage_key: sk }, filesModified: [targetPath], duration_ms: Date.now() - start };
        }
        return { callId: '', success: false, output: { message: result.error }, error: result.error, filesModified: [], duration_ms: Date.now() - start };
    },
});

registerTool({
    name: 'generate_3d_model',
    description: 'AI-generate a 3D model (GLB) via fal.ai (Trellis $0.02 or Hunyuan3D $0.375). Costs 10 credits.',
    parameters: {
        type: 'object',
        properties: {
            prompt: { type: 'string' },
            model: { type: 'string', enum: ['trellis', 'hunyuan3d'], default: 'trellis', description: 'trellis=$0.02 fast, hunyuan3d=$0.375 high quality' },
            image_url: { type: 'string', description: 'Optional: reference image for image-to-3D' },
            target_path: { type: 'string' },
        },
        required: ['prompt', 'target_path'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const prompt = input.prompt as string;
        const targetPath = input.target_path as string;
        const model3d = (input.model as 'trellis' | 'hunyuan3d') || 'trellis';
        const imageUrl = input.image_url as string | undefined;
        const gen3dProv = input.provider as Provider | undefined;

        const result = await generate3D({ prompt, imageUrl, model: model3d, provider: gen3dProv });
        if (result.success && result.modelUrl) {
            const buf = await downloadResult(result.modelUrl);
            const sk = await uploadBinaryAsset(ctx, targetPath, buf, 'model/gltf-binary');
            return { callId: '', success: true, output: { message: `3D model at ${targetPath} (${result.model}, ~$${result.cost.toFixed(3)})`, path: targetPath, storage_key: sk, model_used: result.model, cost: result.cost }, filesModified: [targetPath], duration_ms: Date.now() - start };
        }

        // Fallback placeholder
        await upsertProjectFile(ctx, targetPath.replace('.glb', '.res'), `# 3D placeholder: ${prompt}\n[resource]\ntype = "PrimitiveMesh"\nprimitive = "Box"`, 'text');
        return { callId: '', success: true, output: { message: `Placeholder 3D at ${targetPath}: ${result.error}`, placeholder: true }, filesModified: [targetPath], duration_ms: Date.now() - start };
    },
});

registerTool({
    name: 'generate_animation',
    description: 'Generate animation from a source image using image-to-video AI. Returns a video URL — frame extraction into sprite sheets is handled client-side.',
    parameters: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: 'Description of the desired motion (e.g. "tractor driving forward", "ship rocking on ocean waves", "character running")' },
            source_image_url: { type: 'string', description: 'Public URL of the source static image to animate' },
            model_video: { type: 'string', enum: ['kling', 'minimax', 'wan'], description: 'Video model to use (default: kling)' },
            provider: { type: 'string' },
            target_path: { type: 'string' },
        },
        required: ['prompt', 'source_image_url', 'target_path'],
    },
    access: ['build'],
    execute: async (_ctx, input) => {
        const start = Date.now();
        const prompt = input.prompt as string;
        const sourceImageUrl = input.source_image_url as string;

        const result = await generateAnimation({
            sourceImageUrl,
            prompt,
            model: input.model_video as import('@/lib/assets/generate').ModelVideo | undefined,
            provider: input.provider as Provider | undefined,
        });

        if (!result.success || !result.videoUrl) {
            return { callId: '', success: false, error: result.error || 'Video generation failed', output: { message: result.error }, filesModified: [], duration_ms: Date.now() - start };
        }

        return {
            callId: '', success: true,
            output: {
                message: `Animation video generated (${result.model}, ~$${result.cost.toFixed(3)})`,
                video_url: result.videoUrl,
                model_used: result.model,
                cost: result.cost,
            },
            filesModified: [],
            duration_ms: Date.now() - start,
        };
    },
});

registerTool({
    name: 'create_project_config',
    description: 'Create or update project.axiom configuration. ALWAYS do this first for new games.',
    parameters: {
        type: 'object',
        properties: { project_name: { type: 'string' }, main_scene: { type: 'string' }, display_width: { type: 'integer', default: 1280 }, display_height: { type: 'integer', default: 720 }, game_mode: { type: 'string', enum: ['2d', '3d'] } },
        required: ['project_name', 'main_scene', 'game_mode'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const name = (input.project_name as string) || 'My Game';
        const mainScene = (input.main_scene as string) || 'scenes/main.scene';
        const w = (input.display_width as number) || 1280;
        const h = (input.display_height as number) || 720;
        const is3D = input.game_mode === '3d';
        const config = `; Axiom Engine Project Configuration\nconfig_version=5\n\n[application]\nconfig/name="${name}"\nrun/main_scene="res://${mainScene}"\nconfig/features=PackedStringArray("4.3", "${is3D ? 'Forward Plus' : 'GL Compatibility'}")\n\n[display]\nwindow/size/viewport_width=${w}\nwindow/size/viewport_height=${h}\nwindow/stretch/mode="canvas_items"\n\n[rendering]\nrenderer/rendering_method="${is3D ? 'forward_plus' : 'gl_compatibility'}"\n`;
        await upsertProjectFile(ctx, 'project.axiom', config, 'text');
        return { callId: '', success: true, output: { message: `Project config: ${name} (${is3D ? '3D' : '2D'}, ${w}x${h})`, path: 'project.axiom', mainScene }, filesModified: ['project.axiom'], duration_ms: Date.now() - start };
    },
});
