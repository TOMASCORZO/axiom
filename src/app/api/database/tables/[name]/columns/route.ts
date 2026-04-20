/**
 * Column editor endpoints for the Database Studio.
 *
 *   POST   /api/database/tables/[name]/columns — add a column
 *   PATCH  /api/database/tables/[name]/columns — rename or alter (type / nullable / default) a column
 *   DELETE /api/database/tables/[name]/columns — drop a column
 *
 * All of these build a single ALTER TABLE statement, feed it through the SQL
 * validator (same surface the agent uses), and execute via the
 * SECURITY-DEFINER RPC. The UI never sends raw SQL.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateSql, runStatement } from '@/lib/game-db';
import { resolveProjectAuth } from '@/lib/game-db/auth';

export const maxDuration = 15;

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/i;

const ALLOWED_COL_TYPES: ReadonlySet<string> = new Set([
    'text', 'varchar',
    'int', 'integer', 'bigint', 'smallint',
    'real', 'double precision', 'numeric',
    'boolean', 'bool',
    'uuid',
    'jsonb', 'json',
    'timestamptz', 'timestamp', 'date', 'time',
    'bytea',
]);

function quoteIdent(name: string): string {
    if (!IDENT_RE.test(name)) {
        throw new Error(`Invalid identifier "${name}"`);
    }
    return `"${name}"`;
}

function defaultLiteral(d: unknown): string {
    if (d === null) return 'NULL';
    if (typeof d === 'boolean') return d ? 'TRUE' : 'FALSE';
    if (typeof d === 'number' && Number.isFinite(d)) return String(d);
    if (typeof d === 'string') {
        const lower = d.toLowerCase();
        if (lower === 'now()' || lower === 'gen_random_uuid()' || lower === 'current_timestamp') return lower;
        const tag = `dq${Math.random().toString(36).slice(2, 8)}`;
        return `$${tag}$${d}$${tag}$`;
    }
    throw new Error('default must be a primitive or a supported function string');
}

async function authFor(projectId: string | null) {
    if (!projectId) return { kind: 'err' as const, res: NextResponse.json({ error: 'project_id is required' }, { status: 400 }) };
    const auth = await resolveProjectAuth(projectId);
    if ('status' in auth) return { kind: 'err' as const, res: NextResponse.json({ error: auth.error }, { status: auth.status }) };
    return { kind: 'ok' as const, userId: auth.userId };
}

async function run(sql: string, projectId: string, userId: string, toolName: string) {
    const v = validateSql(sql, projectId);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    try {
        const r = await runStatement(v.statements[0], { projectId, userId, toolName });
        return NextResponse.json({ ok: true, sql, duration_ms: r.duration_ms });
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Execution failed' }, { status: 500 });
    }
}

// POST — add_column
export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
    const { name: tableName } = await params;
    if (!IDENT_RE.test(tableName)) return NextResponse.json({ error: 'Invalid table name' }, { status: 400 });

    let body: {
        project_id?: string;
        column?: { name?: string; type?: string; nullable?: boolean; unique?: boolean; default?: unknown };
    };
    try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const a = await authFor(body.project_id ?? null);
    if (a.kind === 'err') return a.res;

    const col = body.column;
    if (!col?.name || !col.type) return NextResponse.json({ error: 'column.name and column.type required' }, { status: 400 });
    const type = col.type.toLowerCase().trim();
    if (!ALLOWED_COL_TYPES.has(type)) {
        return NextResponse.json({ error: `Type "${type}" not allowed` }, { status: 400 });
    }

    try {
        const parts = [quoteIdent(col.name), type];
        if (col.unique) parts.push('UNIQUE');
        if (col.nullable === false) parts.push('NOT NULL');
        if (col.default !== undefined) parts.push(`DEFAULT ${defaultLiteral(col.default)}`);
        const sql = `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN IF NOT EXISTS ${parts.join(' ')}`;
        return await run(sql, body.project_id!, a.userId, 'column_editor_add');
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid column spec' }, { status: 400 });
    }
}

// PATCH — rename or alter column
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
    const { name: tableName } = await params;
    if (!IDENT_RE.test(tableName)) return NextResponse.json({ error: 'Invalid table name' }, { status: 400 });

    let body: {
        project_id?: string;
        op?: 'rename' | 'set_type' | 'set_nullable' | 'set_default' | 'drop_default';
        column_name?: string;
        to?: string;
        type?: string;
        using?: string;
        nullable?: boolean;
        default?: unknown;
    };
    try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const a = await authFor(body.project_id ?? null);
    if (a.kind === 'err') return a.res;

    const columnName = body.column_name;
    if (!columnName) return NextResponse.json({ error: 'column_name required' }, { status: 400 });

    try {
        const tbl = quoteIdent(tableName);
        const col = quoteIdent(columnName);
        let sql: string;

        switch (body.op) {
            case 'rename': {
                if (!body.to) return NextResponse.json({ error: '`to` required for rename' }, { status: 400 });
                sql = `ALTER TABLE ${tbl} RENAME COLUMN ${col} TO ${quoteIdent(body.to)}`;
                break;
            }
            case 'set_type': {
                const t = body.type?.toLowerCase().trim();
                if (!t || !ALLOWED_COL_TYPES.has(t)) return NextResponse.json({ error: 'type not allowed' }, { status: 400 });
                sql = `ALTER TABLE ${tbl} ALTER COLUMN ${col} TYPE ${t}${body.using ? ` USING ${body.using}` : ''}`;
                break;
            }
            case 'set_nullable': {
                if (typeof body.nullable !== 'boolean') return NextResponse.json({ error: '`nullable` required' }, { status: 400 });
                sql = `ALTER TABLE ${tbl} ALTER COLUMN ${col} ${body.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`;
                break;
            }
            case 'set_default': {
                sql = `ALTER TABLE ${tbl} ALTER COLUMN ${col} SET DEFAULT ${defaultLiteral(body.default)}`;
                break;
            }
            case 'drop_default': {
                sql = `ALTER TABLE ${tbl} ALTER COLUMN ${col} DROP DEFAULT`;
                break;
            }
            default:
                return NextResponse.json({ error: 'Unknown op' }, { status: 400 });
        }

        return await run(sql, body.project_id!, a.userId, 'column_editor_alter');
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid request' }, { status: 400 });
    }
}

// DELETE — drop_column
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
    const { name: tableName } = await params;
    if (!IDENT_RE.test(tableName)) return NextResponse.json({ error: 'Invalid table name' }, { status: 400 });

    let body: { project_id?: string; column_name?: string };
    try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const a = await authFor(body.project_id ?? null);
    if (a.kind === 'err') return a.res;

    const columnName = body.column_name;
    if (!columnName) return NextResponse.json({ error: 'column_name required' }, { status: 400 });

    try {
        const sql = `ALTER TABLE ${quoteIdent(tableName)} DROP COLUMN IF EXISTS ${quoteIdent(columnName)}`;
        return await run(sql, body.project_id!, a.userId, 'column_editor_drop');
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid request' }, { status: 400 });
    }
}
