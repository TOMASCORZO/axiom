import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';
import {
    generateMapObjectV2,
    generateSingleIsoTile,
    composeWangMap,
    composeIsoMap,
} from '@/lib/assets/map-generate';
import type {
    MapMetadataShape,
    MapObjectEntry,
    MapObjectPlacement,
    MapIsoTile,
} from '@/types/asset';

// Longest actions (generate_object, generate_iso_tile, recompose with many
// buffers to download) can take a while — match /generate route's cap.
export const maxDuration = 300;

interface GenerateObjectBody {
    action: 'generate_object';
    project_id: string;
    prompt: string;
    tile_size: number;
    width_tiles?: number;
    height_tiles?: number;
    view?: 'low top-down' | 'high top-down' | 'side';
    target_path: string;
    /** Optional: storage_key of a composed map PNG for style-match via inpainting. */
    background_storage_key?: string;
}

interface GenerateIsoTileBody {
    action: 'generate_iso_tile';
    project_id: string;
    prompt: string;
    tile_size: 16 | 32;
    shape?: 'thin tile' | 'thick tile' | 'block';
    target_path: string;
}

interface RecomposeBody {
    action: 'recompose';
    project_id: string;
    asset_id: string;
    target_path: string;
    metadata: MapMetadataShape;
}

type Body = GenerateObjectBody | GenerateIsoTileBody | RecomposeBody;

async function resolveUser(projectId: string): Promise<string | null> {
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) return user.id;
    const admin = getAdminClient();
    const { data: project } = await admin
        .from('projects')
        .select('owner_id')
        .eq('id', projectId)
        .single();
    return project?.owner_id ?? null;
}

async function uploadAssetBuffer(
    userId: string,
    projectId: string,
    path: string,
    buffer: Buffer,
): Promise<string> {
    const storageKey = `projects/${userId}/${projectId}/${path}`;
    const admin = getAdminClient();
    const { error } = await admin.storage
        .from('assets')
        .upload(storageKey, buffer, { contentType: 'image/png', upsert: true });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
    await admin.from('project_files').upsert({
        project_id: projectId,
        path,
        content_type: 'binary',
        size_bytes: buffer.byteLength,
        storage_key: storageKey,
    }, { onConflict: 'project_id,path' });
    return storageKey;
}

async function downloadStorageKey(storageKey: string): Promise<Buffer> {
    const admin = getAdminClient();
    const { data, error } = await admin.storage.from('assets').download(storageKey);
    if (error || !data) throw new Error(`Storage download failed for ${storageKey}: ${error?.message}`);
    const ab = await data.arrayBuffer();
    return Buffer.from(ab);
}

export async function POST(request: NextRequest) {
    try {
        const body = (await request.json()) as Body;
        const userId = await resolveUser(body.project_id);
        if (!userId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // ── generate_object ──────────────────────────────────────
        if (body.action === 'generate_object') {
            let backgroundImageBase64: string | undefined;
            if (body.background_storage_key) {
                try {
                    const bg = await downloadStorageKey(body.background_storage_key);
                    backgroundImageBase64 = bg.toString('base64');
                } catch {
                    // Style-match is optional — failure shouldn't block object gen.
                    backgroundImageBase64 = undefined;
                }
            }

            const result = await generateMapObjectV2({
                prompt: body.prompt,
                tileSize: body.tile_size,
                widthTiles: body.width_tiles,
                heightTiles: body.height_tiles,
                view: body.view,
                backgroundImageBase64,
            });
            if (!result.success || !result.buffer) {
                return NextResponse.json({ success: false, error: result.error || 'Object generation failed' }, { status: 500 });
            }
            const sk = await uploadAssetBuffer(userId, body.project_id, body.target_path, result.buffer);
            const entry: MapObjectEntry = {
                id: `obj_${crypto.randomUUID().slice(0, 8)}`,
                storage_key: sk,
                name: body.prompt.slice(0, 30),
                width: result.width,
                height: result.height,
                prompt: body.prompt,
            };
            return NextResponse.json({ success: true, object: entry, cost: result.cost });
        }

        // ── generate_iso_tile ────────────────────────────────────
        if (body.action === 'generate_iso_tile') {
            const result = await generateSingleIsoTile({
                prompt: body.prompt,
                tileSize: body.tile_size,
                shape: body.shape,
            });
            if (!result.success || !result.buffer) {
                return NextResponse.json({ success: false, error: result.error || 'Iso tile generation failed' }, { status: 500 });
            }
            const sk = await uploadAssetBuffer(userId, body.project_id, body.target_path, result.buffer);
            const tile: MapIsoTile = {
                id: `iso_${crypto.randomUUID().slice(0, 8)}`,
                storage_key: sk,
                name: body.prompt.slice(0, 30),
                width: result.width,
                height: result.height,
            };
            return NextResponse.json({ success: true, tile, cost: result.cost });
        }

        // ── recompose ────────────────────────────────────────────
        if (body.action === 'recompose') {
            const meta = body.metadata;

            // 1. Library object buffers (shared across projections).
            const objectBufferMap = new Map<string, { buffer: Buffer; w: number; h: number }>();
            for (const o of meta.objects_library) {
                try {
                    const buf = await downloadStorageKey(o.storage_key);
                    objectBufferMap.set(o.id, { buffer: buf, w: o.width, h: o.height });
                } catch {
                    // Missing object in library — skip rather than fail the whole recompose.
                }
            }

            // 2. Project-asset buffers for placements that reference assets dragged from Gallery.
            //    Look up storage_key + dimensions via the assets table; animations
            //    bake the first frame into the composed PNG (export is static).
            const assetBufferMap = new Map<string, { buffer: Buffer; w: number; h: number }>();
            const placementAssetIds = Array.from(new Set(
                (meta.placements as MapObjectPlacement[])
                    .map(p => p.asset_id)
                    .filter((id): id is string => typeof id === 'string'),
            ));
            if (placementAssetIds.length > 0) {
                const admin = getAdminClient();
                const { data: rows } = await admin
                    .from('assets')
                    .select('id, storage_key, width, height, metadata')
                    .in('id', placementAssetIds);
                for (const row of rows ?? []) {
                    try {
                        const fullBuf = await downloadStorageKey(row.storage_key);
                        // For sprite sheets/animations, crop the first frame only so
                        // the map doesn't bake the entire strip onto one cell.
                        const frames = (row.metadata as { frames?: Array<{ x: number; y: number; width: number; height: number }> } | null)?.frames;
                        if (frames && frames.length > 0) {
                            const f0 = frames[0];
                            const sharp = (await import('sharp')).default;
                            const cropped = await sharp(fullBuf)
                                .extract({ left: f0.x, top: f0.y, width: f0.width, height: f0.height })
                                .png()
                                .toBuffer();
                            assetBufferMap.set(row.id, { buffer: cropped, w: f0.width, h: f0.height });
                        } else {
                            assetBufferMap.set(row.id, {
                                buffer: fullBuf,
                                w: row.width ?? meta.tile_size,
                                h: row.height ?? meta.tile_size,
                            });
                        }
                    } catch {
                        // Missing asset — skip the placement rather than failing.
                    }
                }
            }

            const placements = (meta.placements as MapObjectPlacement[])
                .map(p => {
                    let buf: { buffer: Buffer; w: number; h: number } | undefined;
                    if (p.asset_id) buf = assetBufferMap.get(p.asset_id);
                    else if (p.object_id) buf = objectBufferMap.get(p.object_id);
                    if (!buf) return null;
                    return {
                        buffer: buf.buffer,
                        gridX: p.grid_x,
                        gridY: p.grid_y,
                        width: buf.w,
                        height: buf.h,
                        zLevel: p.z_level,
                    };
                })
                .filter((x): x is NonNullable<typeof x> => x !== null);

            let composed: Buffer;
            let outW: number;
            let outH: number;

            if (meta.projection === 'isometric') {
                const tiles = meta.iso_tiles ?? [];
                const tileBufById = new Map<string, Buffer>();
                for (const t of tiles) {
                    try {
                        tileBufById.set(t.id, await downloadStorageKey(t.storage_key));
                    } catch {
                        // Missing tile — cells using it render as gaps.
                    }
                }
                // Prefer iso_stack; fall back to flat iso_grid for legacy maps.
                const stack = meta.iso_stack ?? (meta.iso_grid ?? []).map(row => row.map(id => (id ? [id] : [])));
                const tileStack: (Buffer | null)[][][] = stack.map(row =>
                    row.map(cell => cell.map(id => tileBufById.get(id) ?? null)),
                );
                const firstTile = tiles[0];
                const tileRenderWidth = firstTile?.width ?? meta.tile_size * 2;
                const tileRenderHeight = firstTile?.height ?? meta.tile_size * 2;

                composed = await composeIsoMap({
                    tileSize: meta.tile_size,
                    gridW: meta.grid_w,
                    gridH: meta.grid_h,
                    tileStack,
                    tileRenderWidth,
                    tileRenderHeight,
                    placements,
                });
                // Output dims include stack headroom so the shell dimensions match
                // what composeIsoMap actually produces.
                let maxDepth = 0;
                for (const row of stack) for (const cell of row) if (cell.length > maxDepth) maxDepth = cell.length;
                const stackHeadroom = Math.max(0, maxDepth - 1) * meta.tile_size * 0.5;
                outW = Math.ceil((meta.grid_w + meta.grid_h) * (meta.tile_size / 2) + tileRenderWidth);
                outH = Math.ceil((meta.grid_w + meta.grid_h) * (meta.tile_size / 4) + tileRenderHeight + stackHeadroom);
            } else {
                // Orthogonal (Wang)
                const wangTiles = meta.wang_tiles ?? [];
                const corners = meta.corners ?? [];
                const wangLookup: Array<{ id: string; buffer: Buffer; corners: (typeof wangTiles)[number]['corners'] }> = [];
                for (const t of wangTiles) {
                    try {
                        wangLookup.push({
                            id: t.id,
                            buffer: await downloadStorageKey(t.storage_key),
                            corners: t.corners,
                        });
                    } catch {
                        // Skip missing tile.
                    }
                }

                composed = await composeWangMap({
                    tileSize: meta.tile_size,
                    gridW: meta.grid_w,
                    gridH: meta.grid_h,
                    corners,
                    wangTiles: wangLookup,
                    placements,
                });
                outW = meta.grid_w * meta.tile_size;
                outH = meta.grid_h * meta.tile_size;
            }

            const sk = await uploadAssetBuffer(
                userId,
                body.project_id,
                body.target_path,
                composed,
            );

            const admin = getAdminClient();
            await admin.from('assets')
                .update({
                    storage_key: sk,
                    width: outW,
                    height: outH,
                    metadata: { map: meta, tags: ['map'] },
                })
                .eq('id', body.asset_id);

            return NextResponse.json({
                success: true,
                storage_key: sk,
                width: outW,
                height: outH,
            });
        }

        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    } catch (err) {
        console.error('[map-action] error:', err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Internal server error' },
            { status: 500 },
        );
    }
}
