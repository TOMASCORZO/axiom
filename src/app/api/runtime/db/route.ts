/**
 * POST /api/runtime/db
 * Header: Authorization: Bearer <player JWT>
 * Body: { op, table, scope, ... } — see RuntimeRequest in lib/runtime/db.ts
 *
 * Single endpoint for all runtime DB ops from the game SDK. The player JWT
 * pins (game_id, player_id), so the body never names the game — we always use
 * claims.gid. Any attempt to pass a different game_id is ignored; the SQL
 * builder routes the op to the schema derived from the JWT.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requirePlayer } from '@/lib/runtime/jwt';
import { runRuntimeOp, type RuntimeRequest } from '@/lib/runtime/db';

export const maxDuration = 15;

export async function POST(req: NextRequest) {
    let claims;
    try {
        claims = await requirePlayer(req);
    } catch {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: Partial<RuntimeRequest>;
    try {
        body = (await req.json()) as Partial<RuntimeRequest>;
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body.op || !body.table || !body.scope) {
        return NextResponse.json(
            { error: 'op, table, and scope are required' },
            { status: 400 },
        );
    }
    if (body.scope !== 'player' && body.scope !== 'public') {
        return NextResponse.json({ error: 'scope must be "player" or "public"' }, { status: 400 });
    }
    if (!['select', 'insert', 'update', 'delete'].includes(body.op)) {
        return NextResponse.json({ error: 'op must be select, insert, update, or delete' }, { status: 400 });
    }

    try {
        const result = await runRuntimeOp(body as RuntimeRequest, {
            gameId: claims.gid,
            playerId: claims.sub,
        });
        return NextResponse.json({
            op: result.op,
            rows: result.rows,
            row_count: result.row_count,
            duration_ms: result.duration_ms,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Runtime DB op failed';
        // Builder rejections (bad identifier, missing field, etc.) are 400s.
        // Anything from the Postgres layer is a 500.
        const status = /Invalid|required|allowed|empty|Non-finite|limited|Unsupported|"in"|"like"/.test(message)
            ? 400
            : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
