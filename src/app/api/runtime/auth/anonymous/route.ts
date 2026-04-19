/**
 * POST /api/runtime/auth/anonymous
 * Body: { game_id: string }
 *
 * Mints a fresh player_id + JWT for an anonymous player. Useful for "play
 * without signing in" flows. The same browser will get a *new* player on
 * every call — clients are responsible for caching the JWT in localStorage
 * if they want persistent anon identity.
 */

import { NextRequest, NextResponse } from 'next/server';
import { signPlayerJWT } from '@/lib/runtime/jwt';
import { upsertPlayer } from '@/lib/runtime/players';

export const maxDuration = 10;

export async function POST(req: NextRequest) {
    let body: { game_id?: string };
    try {
        body = (await req.json()) as { game_id?: string };
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const gameId = body.game_id;
    if (!gameId) {
        return NextResponse.json({ error: 'game_id is required' }, { status: 400 });
    }

    try {
        // The provider_user_id for anon players is itself a fresh UUID, which
        // also becomes the player_id on insert (UNIQUE prevents clash).
        const anonId = crypto.randomUUID();
        const player = await upsertPlayer({
            gameId,
            provider: 'anonymous',
            providerUserId: anonId,
        });
        const token = await signPlayerJWT({
            playerId: player.player_id,
            gameId,
            provider: 'anonymous',
        });
        return NextResponse.json({
            access_token: token,
            player_id: player.player_id,
            provider: 'anonymous',
        });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Anonymous auth failed' },
            { status: 500 },
        );
    }
}
