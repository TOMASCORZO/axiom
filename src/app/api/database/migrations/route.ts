/**
 * GET /api/database/migrations?project_id=...
 *
 * Returns the project's DDL history from public.game_schemas, newest first.
 * The Studio's Migrations tab uses this. Each row is a single Console run
 * that included at least one DDL statement — applied in the same order they
 * happened, so replaying them on a fresh Postgres reconstructs the schema.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectAuth } from '@/lib/game-db/auth';
import { getAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 10;

export async function GET(req: NextRequest) {
    const projectId = req.nextUrl.searchParams.get('project_id');
    if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });

    const auth = await resolveProjectAuth(projectId);
    if ('status' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const admin = getAdminClient();
    const { data, error } = await admin
        .from('game_schemas')
        .select('version, sql_up, description, applied_by, applied_at')
        .eq('project_id', projectId)
        .order('version', { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ migrations: data ?? [] });
}
