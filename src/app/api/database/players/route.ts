/**
 * GET    /api/database/players?project_id=... — list players for a game
 *                                                (paginated, newest last_seen first).
 * DELETE /api/database/players               — { project_id, player_id }: delete
 *                                               a single player record. Cascades:
 *                                               the next time that OAuth identity
 *                                               connects they'll get a new player_id.
 *
 * `game_players` is owner-scoped: the project's owner (cookie auth) is the only
 * principal allowed to hit these routes. We reuse resolveProjectAuth so the dev
 * token path and cookie path both work the same way.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabase/admin';
import { resolveProjectAuth } from '@/lib/game-db/auth';

export const maxDuration = 10;

export async function GET(req: NextRequest) {
    const projectId = req.nextUrl.searchParams.get('project_id');
    if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });

    const auth = await resolveProjectAuth(projectId);
    if ('status' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const page = Math.max(1, parseInt(req.nextUrl.searchParams.get('page') ?? '1', 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.nextUrl.searchParams.get('page_size') ?? '50', 10) || 50));
    const offset = (page - 1) * pageSize;

    const admin = getAdminClient();
    const { data, error, count } = await admin
        .from('game_players')
        .select('player_id, provider, provider_user_id, email, display_name, avatar_url, created_at, last_seen_at', { count: 'exact' })
        .eq('game_id', projectId)
        .order('last_seen_at', { ascending: false })
        .range(offset, offset + pageSize - 1);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
        players: data ?? [],
        page,
        page_size: pageSize,
        total: count ?? 0,
    });
}

export async function DELETE(req: NextRequest) {
    let body: { project_id?: string; player_id?: string };
    try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const projectId = body.project_id;
    const playerId = body.player_id;
    if (!projectId || !playerId) return NextResponse.json({ error: 'project_id and player_id are required' }, { status: 400 });

    const auth = await resolveProjectAuth(projectId);
    if ('status' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const admin = getAdminClient();
    const { error } = await admin
        .from('game_players')
        .delete()
        .eq('game_id', projectId)
        .eq('player_id', playerId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
}
