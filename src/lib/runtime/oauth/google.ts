/**
 * Google OAuth 2.0 helpers.
 *
 * We act as the OAuth client on behalf of the game: the game's redirect_uri
 * always points at this Axiom backend, the player's identity is exchanged
 * here, and a short-lived Axiom JWT is then handed to the game over a
 * URL fragment. Means the game never holds Google secrets.
 */

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

function getClientId(): string {
    const v = process.env.GOOGLE_CLIENT_ID;
    if (!v) throw new Error('GOOGLE_CLIENT_ID not configured');
    return v;
}

function getClientSecret(): string {
    const v = process.env.GOOGLE_CLIENT_SECRET;
    if (!v) throw new Error('GOOGLE_CLIENT_SECRET not configured');
    return v;
}

export function getCallbackUrl(origin: string): string {
    return `${origin}/api/runtime/auth/oauth/google/callback`;
}

export function buildAuthorizeUrl(args: {
    origin: string;
    state: string;
}): string {
    const params = new URLSearchParams({
        client_id: getClientId(),
        redirect_uri: getCallbackUrl(args.origin),
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'online',
        prompt: 'select_account',
        state: args.state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface GoogleUser {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
}

export async function exchangeCodeForUser(args: {
    code: string;
    origin: string;
}): Promise<GoogleUser> {
    const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code: args.code,
            client_id: getClientId(),
            client_secret: getClientSecret(),
            redirect_uri: getCallbackUrl(args.origin),
            grant_type: 'authorization_code',
        }),
    });
    if (!tokenRes.ok) {
        throw new Error(`Google token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
    }
    const { access_token } = (await tokenRes.json()) as { access_token: string };

    const userRes = await fetch(USERINFO_URL, {
        headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!userRes.ok) {
        throw new Error(`Google userinfo failed: ${userRes.status}`);
    }
    return (await userRes.json()) as GoogleUser;
}
