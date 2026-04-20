/**
 * Foreign-key constraint editor for the Database Studio.
 *
 *   POST   /api/database/tables/[name]/constraints — add a foreign key
 *   DELETE /api/database/tables/[name]/constraints — drop a constraint by name
 *
 * Emits a single ALTER TABLE statement through the same validator +
 * SECURITY DEFINER RPC pipeline as every other DDL endpoint. The UI never
 * sends raw SQL.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateSql, runStatement } from '@/lib/game-db';
import { resolveProjectAuth } from '@/lib/game-db/auth';

export const maxDuration = 15;

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/i;

const FK_ACTIONS: ReadonlySet<string> = new Set([
    'NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT',
]);

function quoteIdent(name: string): string {
    if (!IDENT_RE.test(name)) {
        throw new Error(`Invalid identifier "${name}"`);
    }
    return `"${name}"`;
}

function normalizeAction(a: unknown, field: string): string {
    if (a == null) return 'NO ACTION';
    const up = String(a).toUpperCase().trim();
    if (!FK_ACTIONS.has(up)) throw new Error(`Invalid ${field}: ${a}`);
    return up;
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

// POST — add_foreign_key
export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
    const { name: tableName } = await params;
    if (!IDENT_RE.test(tableName)) return NextResponse.json({ error: 'Invalid table name' }, { status: 400 });

    let body: {
        project_id?: string;
        name?: string;
        columns?: string[];
        ref_table?: string;
        ref_columns?: string[];
        on_delete?: string;
        on_update?: string;
    };
    try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const a = await authFor(body.project_id ?? null);
    if (a.kind === 'err') return a.res;

    const cols = body.columns;
    const refCols = body.ref_columns;
    if (!Array.isArray(cols) || cols.length === 0) return NextResponse.json({ error: 'columns[] required' }, { status: 400 });
    if (!Array.isArray(refCols) || refCols.length !== cols.length) {
        return NextResponse.json({ error: 'ref_columns[] must match columns[] length' }, { status: 400 });
    }
    if (!body.ref_table) return NextResponse.json({ error: 'ref_table required' }, { status: 400 });

    try {
        const constraintName = body.name ?? `${tableName}_${cols.join('_')}_fkey`;
        const onDelete = normalizeAction(body.on_delete, 'on_delete');
        const onUpdate = normalizeAction(body.on_update, 'on_update');
        const sql =
            `ALTER TABLE ${quoteIdent(tableName)} ` +
            `ADD CONSTRAINT ${quoteIdent(constraintName)} ` +
            `FOREIGN KEY (${cols.map(quoteIdent).join(', ')}) ` +
            `REFERENCES ${quoteIdent(body.ref_table)} (${refCols.map(quoteIdent).join(', ')}) ` +
            `ON DELETE ${onDelete} ON UPDATE ${onUpdate}`;
        return await run(sql, body.project_id!, a.userId, 'fk_editor_add');
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid FK spec' }, { status: 400 });
    }
}

// DELETE — drop_foreign_key
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
    const { name: tableName } = await params;
    if (!IDENT_RE.test(tableName)) return NextResponse.json({ error: 'Invalid table name' }, { status: 400 });

    let body: { project_id?: string; constraint_name?: string };
    try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const a = await authFor(body.project_id ?? null);
    if (a.kind === 'err') return a.res;

    if (!body.constraint_name) return NextResponse.json({ error: 'constraint_name required' }, { status: 400 });

    try {
        const sql = `ALTER TABLE ${quoteIdent(tableName)} DROP CONSTRAINT IF EXISTS ${quoteIdent(body.constraint_name)}`;
        return await run(sql, body.project_id!, a.userId, 'fk_editor_drop');
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid request' }, { status: 400 });
    }
}
