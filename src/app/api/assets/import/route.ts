import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 30;

// POST /api/assets/import — Download a free asset and add it to the project
export async function POST(request: NextRequest) {
    try {
        const supabase = await createServerSupabaseClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const { project_id, download_url, preview_url, target_path, title, source } = body;

        if (!project_id || !target_path) {
            return NextResponse.json({ error: 'project_id and target_path are required' }, { status: 400 });
        }

        // Try download_url first (full asset), then preview_url (thumbnail)
        const url = download_url || preview_url;
        if (!url) {
            return NextResponse.json({ error: 'No download or preview URL available' }, { status: 400 });
        }

        // Download the asset
        const assetRes = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!assetRes.ok) {
            return NextResponse.json(
                { error: `Failed to download from ${source}: ${assetRes.status}` },
                { status: 502 },
            );
        }

        const buffer = await assetRes.arrayBuffer();
        if (buffer.byteLength === 0 || buffer.byteLength > 10 * 1024 * 1024) {
            return NextResponse.json(
                { error: buffer.byteLength === 0 ? 'Empty file' : 'File too large (>10MB)' },
                { status: 400 },
            );
        }

        const mimeType = assetRes.headers.get('content-type') || 'image/png';

        // Upload to Supabase storage
        const admin = getAdminClient();
        const storageKey = `projects/${user.id}/${project_id}/${target_path}`;

        const { error: uploadError } = await admin.storage
            .from('assets')
            .upload(storageKey, buffer, { contentType: mimeType, upsert: true });

        if (uploadError) {
            return NextResponse.json(
                { error: `Storage upload failed: ${uploadError.message}` },
                { status: 500 },
            );
        }

        // Register in project_files
        const { error: dbError } = await admin.from('project_files').upsert({
            project_id,
            path: target_path,
            content_type: 'binary',
            size_bytes: buffer.byteLength,
            storage_key: storageKey,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'project_id,path' });

        if (dbError) {
            console.error('[assets/import] DB registration failed:', dbError.message);
        }

        return NextResponse.json({
            success: true,
            path: target_path,
            size_bytes: buffer.byteLength,
            storage_key: storageKey,
            source: source || 'unknown',
            title: title || target_path,
        });
    } catch (err) {
        console.error('Asset import error:', err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Internal server error' },
            { status: 500 },
        );
    }
}
