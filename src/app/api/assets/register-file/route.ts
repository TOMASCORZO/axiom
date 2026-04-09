import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabase/admin';

// POST /api/assets/register-file — Register an already-uploaded file in project_files
export async function POST(request: NextRequest) {
    try {
        const { project_id, target_path, storage_key, size_bytes } = await request.json();
        if (!project_id || !target_path || !storage_key) {
            return NextResponse.json({ error: 'project_id, target_path, and storage_key are required' }, { status: 400 });
        }

        const admin = getAdminClient();

        await admin.from('project_files').upsert({
            project_id,
            path: target_path,
            content_type: 'binary',
            size_bytes: size_bytes ?? 0,
            storage_key,
        }, { onConflict: 'project_id,path' });

        return NextResponse.json({ success: true, storage_key });
    } catch (err) {
        console.error('Register file error:', err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Internal server error' },
            { status: 500 },
        );
    }
}
