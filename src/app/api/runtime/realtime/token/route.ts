/**
 * POST /api/runtime/realtime/token
 * Header: Authorization: Bearer <player JWT>
 *
 * Exchanges an Axiom player JWT for a short-lived Supabase JWT the SDK can
 * pass to `realtime.setAuth()`. Supabase verifies the token with its own
 * SUPABASE_JWT_SECRET; the `game_id` claim is what RLS on realtime.messages
 * reads to gate channel SELECT/INSERT to `game:<gid>:%`.
 *
 * The token lives 5 minutes — clients refresh on reconnect or before expiry.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requirePlayer, signSupabaseJWT } from '@/lib/runtime/jwt';

export const maxDuration = 5;

export async function POST(req: NextRequest) {
    let claims;
    try {
        claims = await requirePlayer(req);
    } catch {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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
            playerId: claims.sub,
            gameId: claims.gid,
        });
        return NextResponse.json({
            access_token: token,
            expires_in: expiresIn,
            game_id: claims.gid,
            supabase_url: supabaseUrl,
            supabase_anon_key: anonKey,
            channel_prefix: `game:${claims.gid}:`,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Token mint failed';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
