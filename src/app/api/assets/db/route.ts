import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabase/admin';

// GET /api/assets/db?project_id=xxx — Load all assets for a project
export async function GET(req: NextRequest) {
    const projectId = req.nextUrl.searchParams.get('project_id');
    if (!projectId) {
        return NextResponse.json({ error: 'project_id required' }, { status: 400 });
    }

    try {
        const admin = getAdminClient();
        const { data: assets, error } = await admin
            .from('assets')
            .select('*')
            .eq('project_id', projectId)
            .order('created_at', { ascending: false });

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ assets: assets ?? [] });
    } catch {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// POST /api/assets/db — Create/upsert an asset
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { id, project_id, name, asset_type, storage_key, thumbnail_key, file_format, width, height, metadata, generation_prompt, generation_model, size_bytes } = body;

        if (!project_id || !name || !storage_key) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        const admin = getAdminClient();
        const { error } = await admin.from('assets').upsert({
            id,
            project_id,
            name,
            asset_type: asset_type || 'sprite',
            storage_key,
            thumbnail_key: thumbnail_key || null,
            file_format: file_format || 'png',
            width: width || null,
            height: height || null,
            metadata: metadata || {},
            generation_prompt: generation_prompt || null,
            generation_model: generation_model || null,
            size_bytes: size_bytes || 0,
        }, { onConflict: 'id' });

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    } catch {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// DELETE /api/assets/db?id=xxx — Delete an asset
export async function DELETE(req: NextRequest) {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) {
        return NextResponse.json({ error: 'id required' }, { status: 400 });
    }

    try {
        const admin = getAdminClient();
        const { error } = await admin.from('assets').delete().eq('id', id);

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    } catch {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
