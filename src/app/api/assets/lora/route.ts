import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 120;

// POST /api/assets/lora — Get a signed upload URL for a LoRA file
// Client sends { filename, size } → server returns a signed URL for direct upload to Supabase
export async function POST(request: NextRequest) {
    try {
        const supabase = await createServerSupabaseClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
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

        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const storageKey = `loras/${user.id}/${safeName}`;

        const admin = getAdminClient();

        // Create a signed URL for the client to upload directly to Supabase Storage
        const { data: signedData, error: signedError } = await admin.storage
            .from('assets')
            .createSignedUploadUrl(storageKey, { upsert: true });

        if (signedError || !signedData) {
            return NextResponse.json(
                { error: `Failed to create upload URL: ${signedError?.message ?? 'unknown'}` },
                { status: 500 },
            );
        }

        // Also build the final public/serve URL for when the upload completes
        const { data: urlData } = admin.storage.from('assets').getPublicUrl(storageKey);
        const serveUrl = urlData?.publicUrl || `/api/assets/serve?key=${encodeURIComponent(storageKey)}`;

        return NextResponse.json({
            success: true,
            signed_url: signedData.signedUrl,
            token: signedData.token,
            storage_key: storageKey,
            name: filename,
            url: serveUrl,
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
