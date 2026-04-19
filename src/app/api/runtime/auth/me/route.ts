/**
 * GET /api/runtime/auth/me
 * Header: Authorization: Bearer <jwt>
 *
 * Returns the player record for the authenticated JWT. Used by SDK clients
 * to verify a cached token is still valid and to bootstrap UI state.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requirePlayer } from '@/lib/runtime/jwt';
import { getPlayer } from '@/lib/runtime/players';

export const maxDuration = 10;

export async function GET(req: NextRequest) {
    let claims;
    try {
        claims = await requirePlayer(req);
    } catch {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const player = await getPlayer(claims.sub);
    if (!player) return NextResponse.json({ error: 'Player not found' }, { status: 404 });

    return NextResponse.json({
        player_id: player.player_id,
        game_id: player.game_id,
        provider: player.provider,
        email: player.email,
        display_name: player.display_name,
        avatar_url: player.avatar_url,
    });
}
