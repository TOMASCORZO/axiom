/**
 * Runtime DB op builder + executor.
 *
 * Game runtimes never send raw SQL. They send structured ops (select/insert/
 * update/delete) which we translate into SQL here, then run through the same
 * validator + RPC pipeline as the Studio. The translation is the security
 * boundary: every identifier is regex-checked, every value is literalized
 * server-side, and the player_id scoping is enforced before the SQL is built.
 *
 * Two scopes:
 *   - "player": SELECT/UPDATE/DELETE auto-AND a `player_id = '<jwt.sub>'`
 *               clause; INSERT forcibly sets `player_id` to the JWT sub. This
 *               is the only safe write mode in v1 (no RLS on game schemas).
 *   - "public": no auto-restriction; SELECT/INSERT only. UPDATE and DELETE
 *               on public scope are rejected — without per-row ACLs a player
 *               could overwrite somebody else's leaderboard entry.
 */

import { gameSchemaName } from '@/lib/game-db/schema';
import { validateSql } from '@/lib/game-db';
import { safeIdent, safeLiteral } from '@/lib/game-db/literals';
import { getAdminClient } from '@/lib/supabase/admin';
import { broadcastChanges, type CdcOp } from './cdc';

export type RuntimeOp = 'select' | 'insert' | 'update' | 'delete';
export type Scope = 'player' | 'public';

export type FilterOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'like';

export interface Filter {
    column: string;
    op: FilterOp;
    value: unknown;
}

export interface OrderClause {
    column: string;
    ascending?: boolean;
}

export interface RuntimeRequest {
    op: RuntimeOp;
    table: string;
    scope: Scope;
    columns?: string[];
    filters?: Filter[];
    order?: OrderClause[];
    limit?: number;
    offset?: number;
    values?: Record<string, unknown> | Record<string, unknown>[];
    set?: Record<string, unknown>;
}

export interface RuntimeContext {
    gameId: string;
    playerId: string;
}

export interface RuntimeResult {
    op: RuntimeOp;
    rows: Record<string, unknown>[];
    row_count: number;
    duration_ms: number;
    sql: string;
}

const ident = safeIdent;
const literal = safeLiteral;

function buildWhere(filters: Filter[] | undefined, scope: Scope, playerId: string): string {
    const parts: string[] = [];
    if (scope === 'player') {
        // Player ID comes from the verified JWT, but escape defensively anyway.
        parts.push(`"player_id" = '${playerId.replace(/'/g, "''")}'`);
    }
    for (const f of filters ?? []) {
        const col = ident(f.column);
        if (f.op === 'in') {
            if (!Array.isArray(f.value) || f.value.length === 0) {
                throw new Error('"in" requires a non-empty array');
            }
            const items = f.value.map(literal).join(', ');
            parts.push(`${col} IN (${items})`);
        } else if (f.op === 'like') {
            if (typeof f.value !== 'string') throw new Error('"like" requires a string value');
            parts.push(`${col} LIKE ${literal(f.value)}`);
        } else {
            parts.push(`${col} ${f.op} ${literal(f.value)}`);
        }
    }
    return parts.length === 0 ? '' : ' WHERE ' + parts.join(' AND ');
}

function buildSelect(req: RuntimeRequest, ctx: RuntimeContext): string {
    const cols = (req.columns && req.columns.length > 0)
        ? req.columns.map(c => c === '*' ? '*' : ident(c)).join(', ')
        : '*';
    let sql = `SELECT ${cols} FROM ${ident(req.table)}`;
    sql += buildWhere(req.filters, req.scope, ctx.playerId);
    if (req.order && req.order.length > 0) {
        sql += ' ORDER BY ' + req.order
            .map(o => `${ident(o.column)} ${o.ascending === false ? 'DESC' : 'ASC'}`)
            .join(', ');
    }
    const limit = Math.min(Math.max(1, Math.floor(req.limit ?? 100)), 1000);
    sql += ` LIMIT ${limit}`;
    if (req.offset && req.offset > 0) sql += ` OFFSET ${Math.floor(req.offset)}`;
    return sql;
}

function buildInsert(req: RuntimeRequest, ctx: RuntimeContext): string {
    const rowsIn = Array.isArray(req.values)
        ? req.values
        : (req.values ? [req.values] : []);
    if (rowsIn.length === 0) throw new Error('insert requires "values"');
    if (rowsIn.length > 100) throw new Error('insert limited to 100 rows per call');

    // Force player_id under player scope, even if the client tried to set it.
    const enriched = rowsIn.map(r => {
        const copy: Record<string, unknown> = { ...r };
        if (req.scope === 'player') copy['player_id'] = ctx.playerId;
        return copy;
    });

    // Union of keys so a sparse row gets explicit NULL for missing columns.
    const keys = Array.from(new Set(enriched.flatMap(r => Object.keys(r))));
    if (keys.length === 0) throw new Error('insert rows are empty');
    keys.forEach(ident);

    const cols = keys.map(ident).join(', ');
    const values = enriched
        .map(r => `(${keys.map(k => k in r ? literal(r[k]) : 'NULL').join(', ')})`)
        .join(', ');

    return `INSERT INTO ${ident(req.table)} (${cols}) VALUES ${values} RETURNING *`;
}

function buildUpdate(req: RuntimeRequest, ctx: RuntimeContext): string {
    if (req.scope !== 'player') {
        throw new Error('update is only allowed with scope: "player"');
    }
    if (!req.set || Object.keys(req.set).length === 0) {
        throw new Error('update requires "set"');
    }
    // Strip player_id from SET — it's the security key, never updatable.
    const entries = Object.entries(req.set).filter(([k]) => k !== 'player_id');
    if (entries.length === 0) throw new Error('update "set" is empty after stripping player_id');

    const setClause = entries.map(([k, v]) => `${ident(k)} = ${literal(v)}`).join(', ');
    let sql = `UPDATE ${ident(req.table)} SET ${setClause}`;
    sql += buildWhere(req.filters, req.scope, ctx.playerId);
    sql += ' RETURNING *';
    return sql;
}

function buildDelete(req: RuntimeRequest, ctx: RuntimeContext): string {
    if (req.scope !== 'player') {
        throw new Error('delete is only allowed with scope: "player"');
    }
    let sql = `DELETE FROM ${ident(req.table)}`;
    sql += buildWhere(req.filters, req.scope, ctx.playerId);
    sql += ' RETURNING *';
    return sql;
}

export function buildRuntimeSql(req: RuntimeRequest, ctx: RuntimeContext): string {
    switch (req.op) {
        case 'select': return buildSelect(req, ctx);
        case 'insert': return buildInsert(req, ctx);
        case 'update': return buildUpdate(req, ctx);
        case 'delete': return buildDelete(req, ctx);
        default: throw new Error(`Unsupported op: ${(req as { op: string }).op}`);
    }
}

/**
 * Build, validate, and execute a runtime op. Always routes through
 * axiom_query_in_game because every op uses RETURNING * (insert/update/delete)
 * or is a SELECT — both are rows-returning statements from PG's perspective.
 */
export async function runRuntimeOp(req: RuntimeRequest, ctx: RuntimeContext): Promise<RuntimeResult> {
    const sql = buildRuntimeSql(req, ctx);

    // Defense-in-depth: even though we built the SQL ourselves, run it through
    // the same validator the Studio uses. Catches any future builder regression
    // that emits a forbidden statement type or cross-schema reference.
    const v = validateSql(sql, ctx.gameId);
    if (!v.ok) throw new Error(`Built SQL failed validation: ${v.error}`);
    if (v.statements.length !== 1) throw new Error('Runtime ops must produce a single statement');

    const admin = getAdminClient();
    const { data, error } = await admin.rpc('axiom_query_in_game', {
        p_project_id: ctx.gameId,
        p_user_id: ctx.playerId, // recorded in the audit log as the actor
        p_tool_name: 'runtime_sdk',
        p_sql: sql,
    });
    if (error) throw new Error(error.message);
    const result = data as { rows?: Record<string, unknown>[]; row_count?: number; duration_ms?: number };
    const rows = result.rows ?? [];

    // CDC fan-out for mutations. SELECT never emits — it doesn't change state.
    // Fire-and-forget so slow Realtime doesn't stretch the SDK response.
    if (req.op !== 'select' && rows.length > 0) {
        const cdcOp: CdcOp = req.op === 'insert' ? 'INSERT'
            : req.op === 'update' ? 'UPDATE'
            : 'DELETE';
        void broadcastChanges({ gameId: ctx.gameId, table: req.table, op: cdcOp, rows });
    }

    return {
        op: req.op,
        rows,
        row_count: result.row_count ?? 0,
        duration_ms: result.duration_ms ?? 0,
        sql,
    };
}

export function gameSchemaForRuntime(gameId: string): string {
    return gameSchemaName(gameId);
}
