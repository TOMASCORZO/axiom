/**
 * Player JWT helpers for the runtime layer.
 *
 * Tokens are signed with HS256 using AXIOM_RUNTIME_JWT_SECRET — deliberately
 * separate from the Supabase Auth JWT secret so that swapping out Supabase
 * later doesn't break already-issued player tokens. Payload is intentionally
 * minimal (sub, gid, prv) to keep token size small for game runtimes.
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

const ALG = 'HS256';
const ISSUER = 'axiom';
const TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface PlayerClaims {
    sub: string;       // player_id
    gid: string;       // game_id
    prv: 'anonymous' | 'google' | 'discord' | 'github';
    iat: number;
    exp: number;
    iss: string;
}

function getSecret(): Uint8Array {
    const raw = process.env.AXIOM_RUNTIME_JWT_SECRET;
    if (!raw || raw.length < 32) {
        throw new Error('AXIOM_RUNTIME_JWT_SECRET is missing or too short (need ≥ 32 chars).');
    }
    return new TextEncoder().encode(raw);
}

export async function signPlayerJWT(args: {
    playerId: string;
    gameId: string;
    provider: PlayerClaims['prv'];
}): Promise<string> {
    return await new SignJWT({ gid: args.gameId, prv: args.provider })
        .setProtectedHeader({ alg: ALG })
        .setSubject(args.playerId)
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime(`${TOKEN_LIFETIME_SECONDS}s`)
        .sign(getSecret());
}

export async function verifyPlayerJWT(token: string): Promise<PlayerClaims> {
    const { payload } = await jwtVerify(token, getSecret(), {
        issuer: ISSUER,
        algorithms: [ALG],
    });
    return payload as unknown as PlayerClaims;
}

/**
 * Extract bearer token from a request, verify it, and return the claims.
 * Throws on missing or invalid token — callers should catch and 401.
 */
export async function requirePlayer(req: Request): Promise<PlayerClaims> {
    const auth = req.headers.get('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m) throw new Error('Missing bearer token');
    return await verifyPlayerJWT(m[1]);
}

/**
 * Short-lived JWT used to round-trip OAuth state (game_id + redirect_to)
 * through the provider so the callback can resume safely.
 */
export interface OAuthStateClaims extends JWTPayload {
    gid: string;
    rt: string;       // redirect_to
    nonce: string;
}

export async function signOAuthState(gameId: string, redirectTo: string): Promise<string> {
    return await new SignJWT({
        gid: gameId,
        rt: redirectTo,
        nonce: crypto.randomUUID(),
    })
        .setProtectedHeader({ alg: ALG })
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(getSecret());
}

export async function verifyOAuthState(state: string): Promise<OAuthStateClaims> {
    const { payload } = await jwtVerify(state, getSecret(), {
        issuer: ISSUER,
        algorithms: [ALG],
    });
    return payload as OAuthStateClaims;
}
