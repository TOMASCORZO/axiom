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
import { tryParseMapMetadata, sanitizePlacements } from '@/lib/map-schema';

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
    /** The metadata.version the client loaded. Server rejects with 409 if
     *  the DB row has advanced past this, indicating a concurrent save. */
    expected_version?: number;
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
            // 1a. Runtime-validate the incoming metadata so a malformed
            //     client payload can't poison the stored JSONB or crash the
            //     compositor. Strip unknown fields, enforce grid caps.
            const parsed = tryParseMapMetadata(body.metadata);
            if (!parsed.ok) {
                return NextResponse.json(
                    { success: false, error: `Invalid metadata: ${parsed.error}` },
                    { status: 400 },
                );
            }
            // 1b. Drop out-of-grid placements before they hit storage.
            const meta = sanitizePlacements(parsed.value);

            // 1c. Optimistic-concurrency check. The client sends the version
            //     it loaded; we compare against the row's current version and
            //     bail with 409 if someone else saved in the meantime. The
            //     CAS happens on the final UPDATE — this early read just
            //     surfaces the conflict before we spend 30s recomposing.
            const adminEarly = getAdminClient();
            const { data: currentRow, error: readErr } = await adminEarly
                .from('assets')
                .select('id, metadata')
                .eq('id', body.asset_id)
                .single();
            if (readErr || !currentRow) {
                return NextResponse.json(
                    { success: false, error: `Asset not found: ${body.asset_id}` },
                    { status: 404 },
                );
            }
            const dbMap = (currentRow.metadata as { map?: MapMetadataShape } | null)?.map;
            const dbVersion = dbMap?.version ?? 0;
            const expected = body.expected_version ?? dbVersion;
            if (dbVersion !== expected) {
                return NextResponse.json(
                    {
                        success: false,
                        error: `Map was modified elsewhere — reload to continue (db v${dbVersion} vs expected v${expected})`,
                        conflict: true,
                        current_version: dbVersion,
                    },
                    { status: 409 },
                );
            }

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

            // Group placements by layer so we can skip invisible/collision
            // layers, apply per-layer opacity, and draw in z_order. Layers are
            // already migrated by `ensureLayers` before validation.
            const layers = meta.layers ?? [];
            const layerById = new Map(layers.map(l => [l.id, l]));
            const sortedLayers = [...layers].sort((a, b) => a.z_order - b.z_order);
            const renderableLayerIds = new Set(
                sortedLayers
                    .filter(l => l.visible && l.kind !== 'collision')
                    .map(l => l.id),
            );
            const layerOrderIndex = new Map(sortedLayers.map((l, i) => [l.id, i]));
            const placements = (meta.placements as MapObjectPlacement[])
                .filter(p => {
                    const lid = p.layer_id;
                    // Untagged placements (shouldn't exist after migration but
                    // defensive) render on the terrain layer by default.
                    if (!lid) return true;
                    return renderableLayerIds.has(lid);
                })
                .sort((a, b) => {
                    const ai = layerOrderIndex.get(a.layer_id ?? '') ?? 0;
                    const bi = layerOrderIndex.get(b.layer_id ?? '') ?? 0;
                    return ai - bi;
                })
                .map(p => {
                    let buf: { buffer: Buffer; w: number; h: number } | undefined;
                    if (p.asset_id) buf = assetBufferMap.get(p.asset_id);
                    else if (p.object_id) buf = objectBufferMap.get(p.object_id);
                    if (!buf) return null;
                    const layer = p.layer_id ? layerById.get(p.layer_id) : undefined;
                    return {
                        buffer: buf.buffer,
                        gridX: p.grid_x,
                        gridY: p.grid_y,
                        width: buf.w,
                        height: buf.h,
                        zLevel: p.z_level,
                        opacity: layer?.opacity ?? 1,
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
                // Use the TALLEST tile so the canvas has enough room no matter
                // which variant lands on the top row. Width stays from tile[0]
                // (horizontal centering happens per-tile inside composeIsoMap).
                const firstTile = tiles[0];
                const tileRenderWidth = firstTile?.width ?? meta.tile_size * 2;
                const tileRenderHeight = tiles.reduce((m, t) => Math.max(m, t.height), 0)
                    || meta.tile_size * 2;

                composed = await composeIsoMap({
                    tileSize: meta.tile_size,
                    gridW: meta.grid_w,
                    gridH: meta.grid_h,
                    tileStack,
                    tileRenderWidth,
                    tileRenderHeight,
                    placements,
                });
                // Output dims must match what composeIsoMap actually produces,
                // including top overhang for tall blocks + per-level stack headroom.
                let maxDepth = 0;
                for (const row of stack) for (const cell of row) if (cell.length > maxDepth) maxDepth = cell.length;
                const stackStep = Math.max(meta.tile_size / 2, tileRenderHeight - meta.tile_size / 2);
                const stackHeadroom = Math.max(0, maxDepth - 1) * stackStep;
                const topOverhang = Math.max(0, tileRenderHeight - meta.tile_size / 2);
                outW = Math.ceil((meta.grid_w + meta.grid_h) * (meta.tile_size / 2) + tileRenderWidth);
                outH = Math.ceil(
                    (meta.grid_w + meta.grid_h) * (meta.tile_size / 4)
                    + meta.tile_size / 2
                    + topOverhang
                    + stackHeadroom,
                );
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

            // Atomic CAS: only commit if the row's version is still what
            // we read before recomposing. If another save raced in during
            // the compose step, this returns 0 rows and we 409. The
            // uploaded PNG is orphaned but harmless — next save will
            // overwrite the storage key.
            //
            // Legacy maps (created before the version field existed) have
            // NULL at metadata->map->>version, which won't match any string
            // filter. For those we skip the JSONB filter on this first save;
            // after it bootstraps to v1 every subsequent save uses the CAS.
            const newVersion = expected + 1;
            const updatedMeta: MapMetadataShape = { ...meta, version: newVersion };
            const admin = getAdminClient();
            let query = admin
                .from('assets')
                .update({
                    storage_key: sk,
                    width: outW,
                    height: outH,
                    metadata: { map: updatedMeta, tags: ['map'] },
                })
                .eq('id', body.asset_id);
            if (dbMap?.version !== undefined) {
                query = query.eq('metadata->map->>version', String(expected));
            }
            const { data: updatedRows, error: updateErr } = await query.select('id');

            if (updateErr) {
                return NextResponse.json(
                    { success: false, error: `DB update failed: ${updateErr.message}` },
                    { status: 500 },
                );
            }
            if (!updatedRows || updatedRows.length === 0) {
                // Row exists but version advanced between the early read and
                // this UPDATE — concurrent save won the race.
                return NextResponse.json(
                    {
                        success: false,
                        error: 'Map was modified during save — reload to continue',
                        conflict: true,
                    },
                    { status: 409 },
                );
            }

            return NextResponse.json({
                success: true,
                storage_key: sk,
                width: outW,
                height: outH,
                version: newVersion,
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
