import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';

// POST /api/assets/upload-url — Get a signed URL for direct client-to-Supabase upload
// This bypasses Vercel's 4.5MB body limit by having the client upload directly.
export async function POST(request: NextRequest) {
    try {
        const { project_id, target_path } = await request.json();
        if (!project_id || !target_path) {
            return NextResponse.json({ error: 'project_id and target_path are required' }, { status: 400 });
        }

        // Auth
        const supabase = await createServerSupabaseClient();
        const { data: { user } } = await supabase.auth.getUser();

        let userId: string;
        if (user) {
            userId = user.id;
        } else {
            const admin = getAdminClient();
            const { data: project } = await admin
                .from('projects')
                .select('owner_id')
                .eq('id', project_id)
                .single();
            if (!project?.owner_id) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
            userId = project.owner_id;
        }

        const storageKey = `projects/${userId}/${project_id}/${target_path}`;
        const admin = getAdminClient();

        const { data, error } = await admin.storage
            .from('assets')
            .createSignedUploadUrl(storageKey, { upsert: true });

        if (error || !data) {
            return NextResponse.json({ error: `Failed to create upload URL: ${error?.message}` }, { status: 500 });
        }

        return NextResponse.json({
            signed_url: data.signedUrl,
            token: data.token,
            storage_key: storageKey,
        });
    } catch (err) {
        console.error('Upload URL error:', err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Internal server error' },
            { status: 500 },
        );
    }
}
