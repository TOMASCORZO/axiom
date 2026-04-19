/**
 * GET /api/runtime/auth/oauth/google/callback?code=...&state=...
 *
 * Google redirects here after consent. We:
 *   1. Verify the signed state JWT (CSRF + game_id + redirect_to recovery)
 *   2. Exchange the code for the user's Google profile
 *   3. Upsert the (game_id, google, sub) → game_players row
 *   4. Mint an Axiom JWT and hand it to the game via URL fragment
 *
 * URL fragment (#access_token=...) is used because fragments don't get sent
 * to the destination server — only the in-page JS sees them. Same trick OAuth
 * implicit flow uses.
 */

import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForUser } from '@/lib/runtime/oauth/google';
import { signPlayerJWT, verifyOAuthState } from '@/lib/runtime/jwt';
import { upsertPlayer } from '@/lib/runtime/players';

export const maxDuration = 15;

export async function GET(req: NextRequest) {
    const code = req.nextUrl.searchParams.get('code');
    const state = req.nextUrl.searchParams.get('state');
    const oauthError = req.nextUrl.searchParams.get('error');

    if (oauthError) {
        return errorRedirect(req, null, oauthError);
    }
    if (!code || !state) {
        return NextResponse.json({ error: 'code and state are required' }, { status: 400 });
    }

    let gameId: string;
    let redirectTo: string;
    try {
        const claims = await verifyOAuthState(state);
        gameId = claims.gid;
        redirectTo = claims.rt;
    } catch {
        return NextResponse.json({ error: 'Invalid OAuth state' }, { status: 400 });
    }

    try {
        const origin = req.nextUrl.origin;
        const guser = await exchangeCodeForUser({ code, origin });
        if (!guser.sub) throw new Error('Google did not return a user id');

        const player = await upsertPlayer({
            gameId,
            provider: 'google',
            providerUserId: guser.sub,
            email: guser.email ?? null,
            displayName: guser.name ?? null,
            avatarUrl: guser.picture ?? null,
        });

        const token = await signPlayerJWT({
            playerId: player.player_id,
            gameId,
            provider: 'google',
        });

        const target = new URL(redirectTo);
        target.hash = new URLSearchParams({
            access_token: token,
            provider: 'google',
            player_id: player.player_id,
        }).toString();
        return NextResponse.redirect(target.toString(), 302);
    } catch (err) {
        return errorRedirect(req, redirectTo, err instanceof Error ? err.message : 'OAuth failed');
    }
}

function errorRedirect(req: NextRequest, redirectTo: string | null, message: string) {
    if (!redirectTo) {
        return NextResponse.json({ error: message }, { status: 500 });
    }
    try {
        const target = new URL(redirectTo);
        target.hash = new URLSearchParams({ error: message }).toString();
        return NextResponse.redirect(target.toString(), 302);
    } catch {
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
