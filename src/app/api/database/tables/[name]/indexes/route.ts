/**
 * Index editor for the Database Studio.
 *
 *   POST   /api/database/tables/[name]/indexes — create index
 *   DELETE /api/database/tables/[name]/indexes — drop index by name
 *
 * Same pipeline as every other DDL endpoint: validator + SECURITY DEFINER RPC.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateSql, runStatement } from '@/lib/game-db';
import { resolveProjectAuth } from '@/lib/game-db/auth';

export const maxDuration = 15;

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/i;

function quoteIdent(name: string): string {
    if (!IDENT_RE.test(name)) {
        throw new Error(`Invalid identifier "${name}"`);
    }
    return `"${name}"`;
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

// POST — create_index
export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
    const { name: tableName } = await params;
    if (!IDENT_RE.test(tableName)) return NextResponse.json({ error: 'Invalid table name' }, { status: 400 });

    let body: { project_id?: string; name?: string; columns?: string[]; unique?: boolean };
    try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const a = await authFor(body.project_id ?? null);
    if (a.kind === 'err') return a.res;

    const cols = body.columns;
    if (!Array.isArray(cols) || cols.length === 0) return NextResponse.json({ error: 'columns[] required' }, { status: 400 });

    try {
        const indexName = body.name ?? `${tableName}_${cols.join('_')}_idx`;
        const unique = body.unique ? 'UNIQUE ' : '';
        const sql =
            `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdent(indexName)} ` +
            `ON ${quoteIdent(tableName)} (${cols.map(quoteIdent).join(', ')})`;
        return await run(sql, body.project_id!, a.userId, 'index_editor_create');
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid index spec' }, { status: 400 });
    }
}

// DELETE — drop_index
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
    const { name: tableName } = await params;
    if (!IDENT_RE.test(tableName)) return NextResponse.json({ error: 'Invalid table name' }, { status: 400 });

    let body: { project_id?: string; index_name?: string };
    try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const a = await authFor(body.project_id ?? null);
    if (a.kind === 'err') return a.res;

    if (!body.index_name) return NextResponse.json({ error: 'index_name required' }, { status: 400 });

    try {
        const sql = `DROP INDEX IF EXISTS ${quoteIdent(body.index_name)}`;
        return await run(sql, body.project_id!, a.userId, 'index_editor_drop');
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid request' }, { status: 400 });
    }
}
