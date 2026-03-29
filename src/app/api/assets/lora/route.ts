import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 120;

// PUT /api/assets/lora — Stream-upload a LoRA .safetensors file
// Client sends raw binary body with X-Filename and X-Filesize headers.
// This avoids formData() parsing (which buffers the entire file and hits
// Next.js body size limits) and CORS issues with signed URLs.
export async function PUT(request: NextRequest) {
    try {
        const supabase = await createServerSupabaseClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const filename = request.headers.get('x-filename');
        const filesize = Number(request.headers.get('x-filesize') || '0');

        if (!filename) {
            return NextResponse.json({ error: 'Missing X-Filename header' }, { status: 400 });
        }
        if (!filename.endsWith('.safetensors')) {
            return NextResponse.json({ error: 'Only .safetensors files are supported' }, { status: 400 });
        }
        if (filesize > 500 * 1024 * 1024) {
            return NextResponse.json({ error: 'File too large (max 500MB)' }, { status: 400 });
        }

        const body = request.body;
        if (!body) {
            return NextResponse.json({ error: 'No file body' }, { status: 400 });
        }

        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const storageKey = `loras/${user.id}/${safeName}`;

        // Read the stream into a buffer and upload to Supabase Storage
        // Supabase JS SDK doesn't support ReadableStream, so we collect chunks
        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        let totalSize = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            totalSize += value.byteLength;
            // Safety check during streaming
            if (totalSize > 500 * 1024 * 1024) {
                return NextResponse.json({ error: 'File too large (max 500MB)' }, { status: 400 });
            }
        }

        // Combine chunks into a single buffer
        const buffer = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of chunks) {
            buffer.set(chunk, offset);
            offset += chunk.byteLength;
        }

        const admin = getAdminClient();
        const { error: uploadError } = await admin.storage
            .from('assets')
            .upload(storageKey, buffer, {
                contentType: 'application/octet-stream',
                upsert: true,
            });

        if (uploadError) {
            return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
        }

        const { data: urlData } = admin.storage.from('assets').getPublicUrl(storageKey);

        return NextResponse.json({
            success: true,
            name: filename,
            size_bytes: totalSize,
            storage_key: storageKey,
            url: urlData?.publicUrl || `/api/assets/serve?key=${encodeURIComponent(storageKey)}`,
        });
    } catch (err) {
        console.error('LoRA upload error:', err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Internal server error' },
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
