/**
 * POST /api/database/reset
 * Body: { project_id: string, confirm: string }
 *
 * Hard-resets the project's game schema: DROP SCHEMA … CASCADE; CREATE SCHEMA;
 * also wipes the project's migration history. The Studio's "Reset database"
 * action is the only intended caller. We require the body to echo back the
 * project_id as `confirm` so a misclick or replayed request can't nuke a
 * different project than the user intended.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectAuth } from '@/lib/game-db/auth';
import { getAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 15;

export async function POST(req: NextRequest) {
    let body: { project_id?: string; confirm?: string };
    try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    if (!body.project_id) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    if (body.confirm !== body.project_id) {
        return NextResponse.json({ error: 'confirm must equal project_id' }, { status: 400 });
    }

    const auth = await resolveProjectAuth(body.project_id);
    if ('status' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    try {
        const admin = getAdminClient();
        const { data, error } = await admin.rpc('axiom_drop_game_schema', {
            p_project_id: body.project_id,
            p_user_id: auth.userId,
        });
        if (error) throw new Error(error.message);
        return NextResponse.json({ ok: true, ...(data as Record<string, unknown>) });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Reset failed' },
            { status: 500 },
        );
    }
}
