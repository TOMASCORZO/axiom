import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabase/admin';
import { resolveProjectAuth } from '@/lib/game-db/auth';

export const maxDuration = 15;

// GET /api/database/audit?project_id=...&limit=50
export async function GET(req: NextRequest) {
    const projectId = req.nextUrl.searchParams.get('project_id');
    if (!projectId) {
        return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }
    const limit = Math.min(200, Math.max(1, parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10) || 50));

    const auth = await resolveProjectAuth(projectId);
    if ('status' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const admin = getAdminClient();
    const { data, error } = await admin
        .from('database_audit')
        .select('id, tool_name, statement, kind, success, row_count, duration_ms, error, executed_at')
        .eq('project_id', projectId)
        .order('executed_at', { ascending: false })
        .limit(limit);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ entries: data ?? [] });
}
