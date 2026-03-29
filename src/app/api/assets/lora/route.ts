import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';
import { writeFile, readFile, unlink, mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

export const maxDuration = 300; // 5 minutes for large uploads

const CHUNK_MAX = 6 * 1024 * 1024; // 6MB per chunk

// POST /api/assets/lora — Initialize or complete a chunked upload
export async function POST(request: NextRequest) {
    try {
        const supabase = await createServerSupabaseClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const { action } = body as { action: string };

        if (action === 'init') {
            return handleInit(body, user.id);
        } else if (action === 'complete') {
            return await handleComplete(body, user.id);
        }

        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    } catch (err) {
        console.error('LoRA upload error:', err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Internal server error' },
            { status: 500 },
        );
    }
}

// PUT /api/assets/lora — Upload a single chunk (max 6MB)
export async function PUT(request: NextRequest) {
    try {
        const supabase = await createServerSupabaseClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const uploadId = request.headers.get('x-upload-id');
        const chunkIndex = request.headers.get('x-chunk-index');

        if (!uploadId || chunkIndex === null) {
            return NextResponse.json({ error: 'Missing upload headers' }, { status: 400 });
        }

        const bodyBuf = await request.arrayBuffer();
        if (bodyBuf.byteLength > CHUNK_MAX) {
            return NextResponse.json({ error: 'Chunk too large' }, { status: 400 });
        }

        const chunkDir = join(tmpdir(), 'axiom-lora', uploadId);
        await mkdir(chunkDir, { recursive: true });
        const chunkPath = join(chunkDir, `chunk_${chunkIndex.padStart(5, '0')}`);
        await writeFile(chunkPath, Buffer.from(bodyBuf));

        return NextResponse.json({ success: true, chunk: Number(chunkIndex) });
    } catch (err) {
        console.error('Chunk upload error:', err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Chunk upload failed' },
            { status: 500 },
        );
    }
}

function handleInit(body: Record<string, unknown>, userId: string) {
    const { filename, size } = body as { filename?: string; size?: number };

    if (!filename || typeof filename !== 'string') {
        return NextResponse.json({ error: 'Missing filename' }, { status: 400 });
    }
    if (!filename.endsWith('.safetensors')) {
        return NextResponse.json({ error: 'Only .safetensors files are supported' }, { status: 400 });
    }
    if (size && size > 500 * 1024 * 1024) {
        return NextResponse.json({ error: 'File too large (max 500MB)' }, { status: 400 });
    }

    const uploadId = `${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const chunkSize = 5 * 1024 * 1024; // 5MB chunks
    const totalChunks = Math.ceil((size ?? 0) / chunkSize);

    return NextResponse.json({
        success: true,
        uploadId,
        chunkSize,
        totalChunks,
    });
}

async function handleComplete(body: Record<string, unknown>, userId: string) {
    const { uploadId, filename } = body as { uploadId?: string; filename?: string };

    if (!uploadId || !filename) {
        return NextResponse.json({ error: 'Missing uploadId or filename' }, { status: 400 });
    }

    const chunkDir = join(tmpdir(), 'axiom-lora', uploadId);
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storageKey = `loras/${userId}/${safeName}`;
    const bucketName = 'assets';

    try {
        // Read and combine all chunks in order
        const chunkFiles = (await readdir(chunkDir)).filter(f => f.startsWith('chunk_')).sort();

        if (chunkFiles.length === 0) {
            return NextResponse.json({ error: 'No chunks found' }, { status: 400 });
        }

        let totalSize = 0;
        const chunks: Buffer[] = [];
        for (const cf of chunkFiles) {
            const buf = await readFile(join(chunkDir, cf));
            chunks.push(buf);
            totalSize += buf.byteLength;
        }

        const combined = Buffer.concat(chunks, totalSize);

        // Upload using Supabase TUS resumable protocol (bypasses per-object size limit)
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        const tusEndpoint = `${supabaseUrl}/storage/v1/upload/resumable`;

        // Step 1: Create TUS upload
        const createRes = await fetch(tusEndpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${serviceKey}`,
                'apikey': serviceKey,
                'Tus-Resumable': '1.0.0',
                'Upload-Length': String(totalSize),
                'Upload-Metadata': [
                    `bucketName ${btoa(bucketName)}`,
                    `objectName ${btoa(storageKey)}`,
                    `contentType ${btoa('application/octet-stream')}`,
                ].join(','),
                'x-upsert': 'true',
            },
        });

        if (!createRes.ok) {
            const errText = await createRes.text();
            return NextResponse.json(
                { error: `TUS create failed (${createRes.status}): ${errText}` },
                { status: 500 },
            );
        }

        const uploadUrl = createRes.headers.get('Location');
        if (!uploadUrl) {
            return NextResponse.json({ error: 'TUS: no upload location returned' }, { status: 500 });
        }

        // Step 2: Upload in TUS PATCH chunks (6MB each)
        const TUS_CHUNK = 6 * 1024 * 1024;
        let offset = 0;

        while (offset < totalSize) {
            const end = Math.min(offset + TUS_CHUNK, totalSize);
            const slice = combined.subarray(offset, end);

            const patchRes = await fetch(uploadUrl, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${serviceKey}`,
                    'apikey': serviceKey,
                    'Tus-Resumable': '1.0.0',
                    'Upload-Offset': String(offset),
                    'Content-Type': 'application/offset+octet-stream',
                },
                body: slice,
            });

            if (!patchRes.ok) {
                const errText = await patchRes.text();
                return NextResponse.json(
                    { error: `TUS patch failed at offset ${offset}: ${errText}` },
                    { status: 500 },
                );
            }

            const newOffset = patchRes.headers.get('Upload-Offset');
            offset = newOffset ? Number(newOffset) : end;
        }

        // Clean up temp files
        for (const cf of chunkFiles) {
            await unlink(join(chunkDir, cf)).catch(() => {});
        }
        // rmdir doesn't work on non-empty dirs, but files are deleted
        await unlink(chunkDir).catch(() => {});

        const admin = getAdminClient();
        const { data: urlData } = admin.storage.from(bucketName).getPublicUrl(storageKey);
        const serveUrl = urlData?.publicUrl || `/api/assets/serve?key=${encodeURIComponent(storageKey)}`;

        return NextResponse.json({
            success: true,
            name: filename,
            size_bytes: totalSize,
            storage_key: storageKey,
            url: serveUrl,
        });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Assembly failed' },
            { status: 500 },
        );
    }
}

// GET /api/assets/lora — List user's uploaded LoRAs
export async function GET() {
    try {
        const supabase = await createServerSupabaseClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const admin = getAdminClient();
        const { data: files, error } = await admin.storage
            .from('assets')
            .list(`loras/${user.id}`, { limit: 50, sortBy: { column: 'created_at', order: 'desc' } });

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        const loras = (files ?? []).map(f => ({
            name: f.name,
            size_bytes: f.metadata?.size ?? 0,
            storage_key: `loras/${user.id}/${f.name}`,
            url: `/api/assets/serve?key=${encodeURIComponent(`loras/${user.id}/${f.name}`)}`,
            created_at: f.created_at,
        }));

        return NextResponse.json({ loras });
    } catch {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
