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

// ── Image Generation ───────────────────────────────────────────────

async function generateImage(params: { prompt: string; width: number; height: number }): Promise<ArrayBuffer | null> {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
        try {
            const size = params.width <= 256 && params.height <= 256 ? '256x256' : params.width <= 512 && params.height <= 512 ? '512x512' : '1024x1024';
            const res = await fetch('https://api.openai.com/v1/images/generations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                body: JSON.stringify({ model: 'dall-e-3', prompt: params.prompt, n: 1, size, response_format: 'b64_json' }),
            });
            if (res.ok) {
                const data = await res.json() as { data: Array<{ b64_json: string }> };
                const b64 = data.data[0]?.b64_json;
                if (b64) {
                    const binary = atob(b64);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    return bytes.buffer;
                }
            }
        } catch (err) { console.error('OpenAI image gen failed:', err); }
    }
    const fluxKey = process.env.FLUX_API_KEY;
    if (fluxKey) {
        try {
            const res = await fetch('https://fal.run/fal-ai/flux/dev', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${fluxKey}` },
                body: JSON.stringify({ prompt: params.prompt, image_size: { width: params.width, height: params.height }, num_images: 1 }),
            });
            if (res.ok) {
                const data = await res.json() as { images: Array<{ url: string }> };
                const imageUrl = data.images?.[0]?.url;
                if (imageUrl) { const imgRes = await fetch(imageUrl); return imgRes.arrayBuffer(); }
            }
        } catch (err) { console.error('FLUX image gen failed:', err); }
    }
    return null;
}

// ── Free Asset Search ──────────────────────────────────────────────

interface FreeAssetResult { title: string; url: string; download_url: string | null; preview_url: string | null; license: string; source: string; author: string; }

async function searchOpenGameArt(query: string, assetType: string): Promise<FreeAssetResult[]> {
    const typeMap: Record<string, string> = { sprite: '2d', texture: '2d', tileset: '2d', sprite_sheet: '2d', background: '2d', icon: '2d', model_3d: '3d', sound: 'sounds' };
    try {
        const params = new URLSearchParams({ keys: query, type: typeMap[assetType] || '2d' });
        const res = await fetch(`https://opengameart.org/art-search-advanced?${params}`, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) return [];
        const html = await res.text();
        const results: FreeAssetResult[] = [];
        const re = /<a href="\/content\/([\w-]+)"[^>]*>([^<]+)<\/a>/g;
        let m; let c = 0;
        while ((m = re.exec(html)) !== null && c < 5) {
            results.push({ title: m[2].trim(), url: `https://opengameart.org/content/${m[1]}`, download_url: null, preview_url: null, license: 'CC0/CC-BY/CC-BY-SA', source: 'OpenGameArt', author: 'Community' });
            c++;
        }
        return results;
    } catch { return []; }
}

function searchKenney(query: string, assetType: string): FreeAssetResult[] {
    const keywords = query.toLowerCase().split(/\s+/);
    const packs: Array<{ name: string; slug: string; tags: string[]; type: string }> = [
        { name: 'Platformer Characters', slug: 'simplified-platformer-pack', tags: ['platformer', 'character', 'player', 'sprite'], type: 'sprite' },
        { name: 'Toon Characters 1', slug: 'toon-characters-1', tags: ['character', 'toon', 'cartoon', 'sprite'], type: 'sprite' },
        { name: 'Animal Pack Redux', slug: 'animal-pack-redux', tags: ['animal', 'dog', 'cat', 'sprite'], type: 'sprite' },
        { name: 'Space Shooter Redux', slug: 'space-shooter-redux', tags: ['space', 'ship', 'shooter', 'bullet'], type: 'sprite' },
        { name: 'Pixel Platformer', slug: 'pixel-platformer', tags: ['pixel', 'platformer', 'retro', 'tiles'], type: 'sprite' },
        { name: 'Monster Pack', slug: 'monster-pack', tags: ['monster', 'enemy', 'creature', 'rpg'], type: 'sprite' },
        { name: 'Platformer Art Pixel Redux', slug: 'platformer-art-pixel-redux', tags: ['platformer', 'tiles', 'tileset', 'pixel'], type: 'tileset' },
        { name: 'Roguelike RPG Pack', slug: 'roguelike-rpg-pack', tags: ['roguelike', 'rpg', 'dungeon', 'tileset'], type: 'tileset' },
        { name: 'Tiny Town', slug: 'tiny-town', tags: ['town', 'city', 'building', 'tiles', 'top-down'], type: 'tileset' },
        { name: 'Tiny Dungeon', slug: 'tiny-dungeon', tags: ['dungeon', 'cave', 'tiles', 'dark', 'rpg'], type: 'tileset' },
        { name: 'Prototype Textures', slug: 'prototype-textures', tags: ['prototype', 'texture', 'grid', 'material'], type: 'texture' },
        { name: 'Background Elements Redux', slug: 'background-elements-redux', tags: ['background', 'sky', 'clouds', 'parallax'], type: 'background' },
        { name: 'UI Pack', slug: 'ui-pack', tags: ['ui', 'button', 'menu', 'hud', 'icon'], type: 'icon' },
        { name: 'Game Icons', slug: 'game-icons', tags: ['icon', 'item', 'weapon', 'potion', 'sword'], type: 'icon' },
        { name: 'Nature Kit', slug: 'nature-kit', tags: ['nature', 'tree', 'rock', '3d', 'model'], type: 'model_3d' },
        { name: 'Car Kit', slug: 'car-kit', tags: ['car', 'vehicle', 'racing', '3d', 'model'], type: 'model_3d' },
        { name: 'Castle Kit', slug: 'castle-kit', tags: ['castle', 'medieval', 'tower', '3d', 'model'], type: 'model_3d' },
        { name: 'Interface Sounds', slug: 'interface-sounds', tags: ['ui', 'click', 'menu', 'sound'], type: 'sound' },
        { name: 'Impact Sounds', slug: 'impact-sounds', tags: ['impact', 'hit', 'explosion', 'sound'], type: 'sound' },
    ];
    const scored = packs.map(p => {
        let score = 0;
        for (const kw of keywords) { if (p.tags.some(t => t.includes(kw) || kw.includes(t))) score += 2; if (p.name.toLowerCase().includes(kw)) score += 3; }
        if (p.type === assetType) score += 2;
        return { pack: p, score };
    }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
    return scored.map(({ pack: p }) => ({ title: p.name, url: `https://kenney.nl/assets/${p.slug}`, download_url: `https://kenney.nl/media/pages/assets/${p.slug}/*/content.zip`, preview_url: `https://kenney.nl/media/pages/assets/${p.slug}/*/preview.png`, license: 'CC0 (Public Domain)', source: 'Kenney', author: 'Kenney.nl' }));
}

async function searchItchIo(query: string): Promise<FreeAssetResult[]> {
    try {
        const params = new URLSearchParams({ type: 'game-assets', q: query, 'price-range': 'Free' });
        const res = await fetch(`https://itch.io/search?${params}`, { headers: { 'Accept': 'text/html', 'User-Agent': 'Axiom-Engine/1.0' }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) return [];
        const html = await res.text();
        const results: FreeAssetResult[] = [];
        const re = /<a href="(https:\/\/[^"]+\.itch\.io\/[^"]+)"[^>]*class="title[^"]*"[^>]*>([^<]+)<\/a>/g;
        let m; let c = 0;
        while ((m = re.exec(html)) !== null && c < 5) {
            results.push({ title: m[2].trim(), url: m[1], download_url: null, preview_url: null, license: 'Varies', source: 'itch.io', author: m[1].split('.itch.io')[0].replace('https://', '') });
            c++;
        }
        return results;
    } catch { return []; }
}

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
    description: 'AI-generate a CUSTOM 2D sprite image. Costs 5 credits. Only use when search_free_asset fails.',
    parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' }, style: { type: 'string', enum: ['pixel_art', 'hand_drawn', 'vector', 'realistic', 'stylized'], default: 'stylized' }, width: { type: 'integer', default: 128 }, height: { type: 'integer', default: 128 }, transparent_bg: { type: 'boolean', default: true }, target_path: { type: 'string' } },
        required: ['prompt', 'target_path'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const prompt = input.prompt as string;
        const width = (input.width as number) || 128;
        const height = (input.height as number) || 128;
        const targetPath = input.target_path as string;
        const buf = await generateImage({ prompt: `Game sprite: ${prompt}. ${width}x${height}px.`, width, height });
        if (buf) { await uploadBinaryAsset(ctx, targetPath, buf, 'image/png'); return { callId: '', success: true, output: { message: `Sprite generated at ${targetPath}`, path: targetPath }, filesModified: [targetPath], duration_ms: Date.now() - start }; }
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#8b5cf6" opacity="0.3"/><text x="50%" y="50%" text-anchor="middle" dy=".3em" fill="#fff" font-size="12">${prompt.slice(0, 20)}</text></svg>`;
        await upsertProjectFile(ctx, targetPath, svg, 'text');
        return { callId: '', success: true, output: { message: `Placeholder at ${targetPath}`, path: targetPath, placeholder: true }, filesModified: [targetPath], duration_ms: Date.now() - start };
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
        const buf = await generateImage({ prompt: `Seamless game texture: ${prompt}. ${width}x${height}px.`, width, height });
        if (buf) { await uploadBinaryAsset(ctx, targetPath, buf, 'image/png'); return { callId: '', success: true, output: { message: `Texture at ${targetPath}`, path: targetPath }, filesModified: [targetPath], duration_ms: Date.now() - start }; }
        await upsertProjectFile(ctx, targetPath, `# Placeholder: ${prompt}`, 'text');
        return { callId: '', success: true, output: { message: `Placeholder at ${targetPath}`, placeholder: true }, filesModified: [targetPath], duration_ms: Date.now() - start };
    },
});

registerTool({
    name: 'generate_3d_model',
    description: 'AI-generate a 3D model (GLB) using Meshy AI. Costs 10 credits.',
    parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' }, topology: { type: 'string', enum: ['low_poly', 'standard', 'high_poly'], default: 'standard' }, textured: { type: 'boolean', default: true }, target_path: { type: 'string' } },
        required: ['prompt', 'target_path'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const prompt = input.prompt as string;
        const targetPath = input.target_path as string;
        const meshyKey = process.env.MESHY_API_KEY;
        if (meshyKey) {
            try {
                const createRes = await fetch('https://api.meshy.ai/v2/text-to-3d', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${meshyKey}` }, body: JSON.stringify({ mode: 'preview', prompt, art_style: 'game-asset', topology: 'quad' }) });
                if (createRes.ok) {
                    const { result: taskId } = await createRes.json() as { result: string };
                    for (let i = 0; i < 30; i++) {
                        await new Promise(r => setTimeout(r, 2000));
                        const statusRes = await fetch(`https://api.meshy.ai/v2/text-to-3d/${taskId}`, { headers: { 'Authorization': `Bearer ${meshyKey}` } });
                        if (statusRes.ok) { const s = await statusRes.json() as { status: string; model_urls?: { glb?: string } }; if (s.status === 'SUCCEEDED' && s.model_urls?.glb) { const modelRes = await fetch(s.model_urls.glb); const buf = await modelRes.arrayBuffer(); await uploadBinaryAsset(ctx, targetPath, buf, 'model/gltf-binary'); return { callId: '', success: true, output: { message: `3D model at ${targetPath}`, path: targetPath }, filesModified: [targetPath], duration_ms: Date.now() - start }; } if (s.status === 'FAILED') break; }
                    }
                }
            } catch (err) { console.error('Meshy error:', err); }
        }
        await upsertProjectFile(ctx, targetPath.replace('.glb', '.res'), `# 3D placeholder: ${prompt}\n[resource]\ntype = "PrimitiveMesh"\nprimitive = "Box"`, 'text');
        return { callId: '', success: true, output: { message: `Placeholder 3D at ${targetPath}`, placeholder: true }, filesModified: [targetPath], duration_ms: Date.now() - start };
    },
});

registerTool({
    name: 'generate_animation',
    description: 'Generate animation frames or keyframes.',
    parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' }, type: { type: 'string', enum: ['sprite_frames', 'skeletal', 'keyframe'], default: 'sprite_frames' }, frame_count: { type: 'integer', default: 4 }, fps: { type: 'integer', default: 12 }, loop: { type: 'boolean', default: true }, target_path: { type: 'string' } },
        required: ['prompt', 'target_path'],
    },
    access: ['build'],
    execute: async (ctx, input) => {
        const start = Date.now();
        const fps = (input.fps as number) || 12;
        const loop = input.loop !== false;
        const targetPath = input.target_path as string;
        const animContent = `[axiom_resource format=3]\n\n[resource type="SpriteFrames"]\nanimations = [{"frames": [], "loop": ${loop}, "name": &"default", "speed": ${fps}.0}]\n`;
        await upsertProjectFile(ctx, targetPath, animContent, 'text');
        return { callId: '', success: true, output: { message: `Animation at ${targetPath}`, path: targetPath }, filesModified: [targetPath], duration_ms: Date.now() - start };
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
        const config = `; Axiom Engine Project Configuration\n[application]\nconfig/name="${name}"\nrun/main_scene="res://${mainScene}"\nconfig/features=PackedStringArray("${is3D ? '3D' : '2D'}")\n\n[display]\nwindow/size/viewport_width=${w}\nwindow/size/viewport_height=${h}\nwindow/stretch/mode="canvas_items"\n\n[input]\nui_accept={"events": [Object(InputEventKey,"keycode":4194309)]}\nui_left={"events": [Object(InputEventKey,"keycode":4194319), Object(InputEventKey,"keycode":65)]}\nui_right={"events": [Object(InputEventKey,"keycode":4194321), Object(InputEventKey,"keycode":68)]}\nui_up={"events": [Object(InputEventKey,"keycode":4194320), Object(InputEventKey,"keycode":87)]}\nui_down={"events": [Object(InputEventKey,"keycode":4194322), Object(InputEventKey,"keycode":83)]}\n\n[physics]\n${is3D ? '3d/default_gravity=9.8' : '2d/default_gravity=980.0'}\n\n[rendering]\n${is3D ? 'renderer/rendering_method="forward_plus"' : 'renderer/rendering_method="gl_compatibility"'}\n`;
        await upsertProjectFile(ctx, 'project.axiom', config, 'text');
        return { callId: '', success: true, output: { message: `Project config: ${name} (${is3D ? '3D' : '2D'}, ${w}x${h})`, path: 'project.axiom', mainScene }, filesModified: ['project.axiom'], duration_ms: Date.now() - start };
    },
});
