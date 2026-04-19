/**
 * GET /api/runtime/auth/oauth/google?game_id=...&redirect_to=...
 *
 * Initiates the Google OAuth dance. The redirect_to URL is encoded into a
 * signed state JWT so the callback can resume safely without trusting any
 * query param. Forwards the player to Google's consent screen.
 */

import { NextRequest, NextResponse } from 'next/server';
import { buildAuthorizeUrl } from '@/lib/runtime/oauth/google';
import { signOAuthState } from '@/lib/runtime/jwt';

export const maxDuration = 10;

export async function GET(req: NextRequest) {
    const gameId = req.nextUrl.searchParams.get('game_id');
    const redirectTo = req.nextUrl.searchParams.get('redirect_to');
    if (!gameId || !redirectTo) {
        return NextResponse.json(
            { error: 'game_id and redirect_to are required' },
            { status: 400 },
        );
    }

    // Reject obviously bad redirects (open-redirect protection lives in the
    // callback, but reject non-http(s) early to fail fast).
    if (!/^https?:\/\//i.test(redirectTo)) {
        return NextResponse.json({ error: 'redirect_to must be http(s)' }, { status: 400 });
    }

    try {
        const state = await signOAuthState(gameId, redirectTo);
        const origin = req.nextUrl.origin;
        const url = buildAuthorizeUrl({ origin, state });
        return NextResponse.redirect(url, 302);
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'OAuth init failed' },
            { status: 500 },
        );
    }
}
