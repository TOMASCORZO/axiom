import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';

// GET /api/projects/[id]/files — List project files
// Auth: project_id is a UUID that acts as access token — only the owner knows it
export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const { id } = await params;

        const admin = getAdminClient();
        const { data: files, error } = await admin
            .from('project_files')
            .select('id, path, content_type, text_content, size_bytes, updated_at')
            .eq('project_id', id)
            .order('path');

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ files: files ?? [] });
    } catch {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// POST /api/projects/[id]/files — Create or update a file
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const { id } = await params;

        // Validate auth
        const supabase = await createServerSupabaseClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const { path, content, content_type = 'text' } = body;

        if (!path) {
            return NextResponse.json({ error: 'Path is required' }, { status: 400 });
        }

        const fileData = {
            project_id: id,
            path,
            content_type,
            text_content: content_type === 'text' ? content : null,
            size_bytes: typeof content === 'string' ? new Blob([content]).size : 0,
            updated_at: new Date().toISOString(),
        };

        // Write with admin client (bypasses RLS)
        const admin = getAdminClient();
        const { data: file, error } = await admin
            .from('project_files')
            .upsert(fileData, { onConflict: 'project_id,path' })
            .select()
            .single();

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ file }, { status: 201 });
    } catch {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
