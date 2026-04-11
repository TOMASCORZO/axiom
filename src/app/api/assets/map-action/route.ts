import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';
import {
    generateSingleTile,
    generateMapObject,
    composeMap,
    type ComposeTile,
    type ComposePlacement,
} from '@/lib/assets/map-generate';
import type { MapMetadataShape, MapObjectEntry, MapObjectPlacement } from '@/types/asset';

// Longest action (generate_tile) goes to PixelLab — match /generate route.
export const maxDuration = 300;

interface GenerateTileBody {
    action: 'generate_tile';
    project_id: string;
    prompt: string;
    tile_size: number;
    target_path: string;
}

interface GenerateObjectBody {
    action: 'generate_object';
    project_id: string;
    prompt: string;
    tile_size: number;
    width_tiles?: number;
    height_tiles?: number;
    target_path: string;
}

interface RecomposeBody {
    action: 'recompose';
    project_id: string;
    asset_id: string;
    target_path: string;
    metadata: MapMetadataShape;
}

type Body = GenerateTileBody | GenerateObjectBody | RecomposeBody;

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
    buffer: ArrayBuffer,
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

function toArrayBuffer(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export async function POST(request: NextRequest) {
    try {
        const body = (await request.json()) as Body;
        const userId = await resolveUser(body.project_id);
        if (!userId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // ── generate_tile ────────────────────────────────────────
        if (body.action === 'generate_tile') {
            const result = await generateSingleTile({
                prompt: body.prompt,
                tileSize: body.tile_size,
                seamless: true,
            });
            if (!result.success || !result.buffer) {
                return NextResponse.json({ success: false, error: result.error || 'Tile generation failed' }, { status: 500 });
            }
            const sk = await uploadAssetBuffer(userId, body.project_id, body.target_path, result.buffer);
            return NextResponse.json({
                success: true,
                tile: {
                    id: crypto.randomUUID(),
                    storage_key: sk,
                    name: body.prompt.slice(0, 30),
                    prompt: body.prompt,
                },
                cost: result.cost,
            });
        }

        // ── generate_object ──────────────────────────────────────
        if (body.action === 'generate_object') {
            const result = await generateMapObject({
                prompt: body.prompt,
                tileSize: body.tile_size,
                widthTiles: body.width_tiles,
                heightTiles: body.height_tiles,
            });
            if (!result.success || !result.buffer) {
                return NextResponse.json({ success: false, error: result.error || 'Object generation failed' }, { status: 500 });
            }
            const sk = await uploadAssetBuffer(userId, body.project_id, body.target_path, result.buffer);
            const entry: MapObjectEntry = {
                id: crypto.randomUUID(),
                storage_key: sk,
                name: body.prompt.slice(0, 30),
                width: result.width ?? body.tile_size,
                height: result.height ?? body.tile_size,
                prompt: body.prompt,
            };
            return NextResponse.json({ success: true, object: entry, cost: result.cost });
        }

        // ── recompose ────────────────────────────────────────────
        if (body.action === 'recompose') {
            const meta = body.metadata;
            const tileBuffers: ComposeTile[] = [];
            for (const t of meta.tiles) {
                const buf = await downloadStorageKey(t.storage_key);
                tileBuffers.push({ id: t.id, buffer: buf });
            }

            const objectBufferMap = new Map<string, { buffer: Buffer; w: number; h: number }>();
            for (const o of meta.objects_library) {
                const buf = await downloadStorageKey(o.storage_key);
                objectBufferMap.set(o.id, { buffer: buf, w: o.width, h: o.height });
            }

            const placements: ComposePlacement[] = [];
            for (const p of meta.placements as MapObjectPlacement[]) {
                const obj = objectBufferMap.get(p.object_id);
                if (!obj) continue;
                placements.push({
                    buffer: obj.buffer,
                    gridX: p.grid_x,
                    gridY: p.grid_y,
                    width: obj.w,
                    height: obj.h,
                });
            }

            const composed = await composeMap({
                tileSize: meta.tile_size,
                gridW: meta.grid_w,
                gridH: meta.grid_h,
                grid: meta.grid,
                tiles: tileBuffers,
                placements,
            });

            const sk = await uploadAssetBuffer(
                userId,
                body.project_id,
                body.target_path,
                toArrayBuffer(composed),
            );

            // Update the asset row's metadata + storage_key so the gallery
            // reflects the latest snapshot.
            const admin = getAdminClient();
            await admin.from('assets')
                .update({
                    storage_key: sk,
                    width: meta.grid_w * meta.tile_size,
                    height: meta.grid_h * meta.tile_size,
                    metadata: { map: meta, tags: ['map'] },
                })
                .eq('id', body.asset_id);

            return NextResponse.json({
                success: true,
                storage_key: sk,
                width: meta.grid_w * meta.tile_size,
                height: meta.grid_h * meta.tile_size,
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
