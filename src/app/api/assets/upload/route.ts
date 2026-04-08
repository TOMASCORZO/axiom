import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 60;

// POST /api/assets/upload — Upload a client-generated binary asset (e.g. sprite sheet)
export async function POST(request: NextRequest) {
    try {
        const formData = await request.formData();
        const file = formData.get('file') as File | null;
        const projectId = formData.get('project_id') as string | null;
        const targetPath = formData.get('target_path') as string | null;

        if (!file || !projectId || !targetPath) {
            return NextResponse.json(
                { error: 'file, project_id, and target_path are required' },
                { status: 400 },
            );
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
                .eq('id', projectId)
                .single();
            if (!project?.owner_id) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
            userId = project.owner_id;
        }

        const buffer = await file.arrayBuffer();
        const storageKey = `projects/${userId}/${projectId}/${targetPath}`;
        const admin = getAdminClient();

        const { error } = await admin.storage
            .from('assets')
            .upload(storageKey, buffer, { contentType: file.type || 'image/png', upsert: true });

        if (error) {
            return NextResponse.json({ error: `Storage upload failed: ${error.message}` }, { status: 500 });
        }

        await admin.from('project_files').upsert({
            project_id: projectId,
            path: targetPath,
            content_type: 'binary',
            size_bytes: buffer.byteLength,
            storage_key: storageKey,
        }, { onConflict: 'project_id,path' });

        return NextResponse.json({ success: true, storage_key: storageKey });
    } catch (err) {
        console.error('Asset upload error:', err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Internal server error' },
            { status: 500 },
        );
    }
}
