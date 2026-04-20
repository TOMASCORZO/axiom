/**
 * Change-Data-Capture fan-out for runtime DB ops.
 *
 * After a successful insert/update/delete through /api/runtime/db, we POST a
 * broadcast to Supabase Realtime's REST endpoint so any SDK client subscribed
 * to the table's CDC topic receives the change. No DB triggers, no publication
 * wiring — the broadcast is emitted by the same process that just did the
 * write, while we already have the `RETURNING *` rows in memory.
 *
 *   Topic:   `game:<gameId>:db:<table>`
 *   Event:   'INSERT' | 'UPDATE' | 'DELETE'
 *   Payload: { op, table, row }              (INSERT/DELETE)
 *            { op, table, new: row, ... }    (UPDATE; we don't have OLD here,
 *                                             but SDK callers get the new row)
 *
 * Access control rides on the same JWT/RLS pair used for other broadcasts —
 * the topic is prefixed with `game:<gameId>:`, and `realtime.messages` RLS
 * only lets tokens with a matching `game_id` claim subscribe. We send with the
 * service role key, which bypasses RLS for the publish side.
 *
 * Failure mode: broadcast is fire-and-forget. A 500 from Realtime must not
 * fail the player's write — they already got their row back.
 */

const BROADCAST_TIMEOUT_MS = 2500;

function endpointUrl(): string | null {
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!base) return null;
    return `${base.replace(/\/+$/, '')}/realtime/v1/api/broadcast`;
}

function apikey(): string | null {
    // Service role is what authorizes the publish side (bypasses RLS); the
    // apikey header still needs to be a valid project key — anon is enough.
    return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? null;
}

function serviceKey(): string | null {
    return process.env.SUPABASE_SERVICE_ROLE_KEY ?? null;
}

export type CdcOp = 'INSERT' | 'UPDATE' | 'DELETE';

interface BroadcastArgs {
    gameId: string;
    table: string;
    op: CdcOp;
    rows: Record<string, unknown>[];
}

function buildMessages({ gameId, table, op, rows }: BroadcastArgs) {
    const topic = `game:${gameId}:db:${table}`;
    return rows.map(row => ({
        topic,
        event: op,
        private: true,
        payload: { op, table, row },
    }));
}

/**
 * Fire-and-forget publish. Resolves when the request completes, but errors are
 * swallowed with a console.warn — callers already handled the player's write.
 */
export async function broadcastChanges(args: BroadcastArgs): Promise<void> {
    if (args.rows.length === 0) return;

    const url = endpointUrl();
    const key = apikey();
    const auth = serviceKey();
    if (!url || !key || !auth) {
        // Missing env is an operator problem, not a player problem. Don't
        // throw — the write already succeeded.
        console.warn('[axiom cdc] missing SUPABASE env; skipping broadcast');
        return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BROADCAST_TIMEOUT_MS);

    try {
        const res = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                apikey: key,
                Authorization: `Bearer ${auth}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ messages: buildMessages(args) }),
        });
        if (res.status !== 202) {
            const body = await res.text().catch(() => '');
            console.warn(`[axiom cdc] broadcast ${res.status}: ${body.slice(0, 200)}`);
        }
    } catch (err) {
        if ((err as { name?: string }).name !== 'AbortError') {
            console.warn('[axiom cdc] broadcast failed:', err);
        }
    } finally {
        clearTimeout(timer);
    }
}
