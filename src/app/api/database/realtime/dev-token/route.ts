/**
 * POST /api/database/realtime/dev-token
 * Body: { project_id }
 *
 * Studio-side counterpart to /api/runtime/realtime/token. Devs don't have a
 * player JWT, but they own the project — so we mint a Supabase JWT scoped to
 * their game directly from their cookie/owner auth. This lets the Realtime
 * tab in Database Studio subscribe to their own game's channels for debugging
 * without spinning up a fake player session.
 *
 * The minted JWT carries the dev's user_id as `sub` and the project_id as
 * `game_id` — RLS on realtime.messages still gates by `game_id`, so the dev
 * can only peek into channels for projects they actually own.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectAuth } from '@/lib/game-db/auth';
import { signSupabaseJWT } from '@/lib/runtime/jwt';

export const maxDuration = 5;

export async function POST(req: NextRequest) {
    let body: { project_id?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const projectId = body.project_id;
    if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });

    const auth = await resolveProjectAuth(projectId);
    if ('status' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
        return NextResponse.json(
            { error: 'Realtime not configured (missing NEXT_PUBLIC_SUPABASE_URL/ANON_KEY)' },
            { status: 500 },
        );
    }

    try {
        const { token, expiresIn } = await signSupabaseJWT({
            playerId: auth.userId,
            gameId: projectId,
        });
        return NextResponse.json({
            access_token: token,
            expires_in: expiresIn,
            game_id: projectId,
            supabase_url: supabaseUrl,
            supabase_anon_key: anonKey,
            channel_prefix: `game:${projectId}:`,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Token mint failed';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
