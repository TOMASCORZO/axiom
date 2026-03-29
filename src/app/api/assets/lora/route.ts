import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 60;

// POST /api/assets/lora — Upload a LoRA .safetensors file
export async function POST(request: NextRequest) {
    try {
        const supabase = await createServerSupabaseClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const formData = await request.formData();
        const file = formData.get('file') as File | null;
        if (!file) {
            return NextResponse.json({ error: 'No file provided' }, { status: 400 });
        }

        if (file.size > 500 * 1024 * 1024) {
            return NextResponse.json({ error: 'File too large (max 500MB)' }, { status: 400 });
        }

        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const storageKey = `loras/${user.id}/${safeName}`;
        const buffer = await file.arrayBuffer();

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
            name: file.name,
            size_bytes: file.size,
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
