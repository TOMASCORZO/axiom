/**
 * Per-table rows endpoint for the Database Studio.
 *
 *   GET    — list rows (pagination)
 *   POST   — insert one row
 *   PATCH  — update one row by primary key
 *   DELETE — delete one row by primary key
 *
 * All write paths require the caller to send the row's primary-key columns +
 * values so we can build a fully-qualified WHERE that matches exactly one row.
 * That keeps the inline editor in the UI safe even if a future contributor
 * forgets to add LIMIT — composite PK rows always have an exact match.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateSql, runStatement } from '@/lib/game-db';
import { resolveProjectAuth } from '@/lib/game-db/auth';
import { safeIdent, safeLiteral } from '@/lib/game-db/literals';

export const maxDuration = 15;

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/i;

function badTable() {
    return NextResponse.json({ error: 'Invalid table name' }, { status: 400 });
}

async function authFor(projectId: string | null) {
    if (!projectId) return { kind: 'err' as const, res: NextResponse.json({ error: 'project_id is required' }, { status: 400 }) };
    const auth = await resolveProjectAuth(projectId);
    if ('status' in auth) return { kind: 'err' as const, res: NextResponse.json({ error: auth.error }, { status: auth.status }) };
    return { kind: 'ok' as const, userId: auth.userId };
}

function buildWhereByPk(pk: Record<string, unknown> | undefined): string {
    if (!pk || Object.keys(pk).length === 0) {
        throw new Error('pk (primary key columns + values) is required');
    }
    const parts = Object.entries(pk).map(([k, v]) => {
        if (v === null || v === undefined) {
            // PK columns are non-nullable, so a NULL pk value is always a bug.
            throw new Error(`pk column "${k}" cannot be null`);
        }
        return `${safeIdent(k)} = ${safeLiteral(v)}`;
    });
    return parts.join(' AND ');
}

// ── GET ─────────────────────────────────────────────────────────────────

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ name: string }> },
) {
    const { name } = await params;
    if (!IDENT_RE.test(name)) return badTable();

    const projectId = req.nextUrl.searchParams.get('project_id');
    const a = await authFor(projectId);
    if (a.kind === 'err') return a.res;

    const page = Math.max(1, parseInt(req.nextUrl.searchParams.get('page') ?? '1', 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.nextUrl.searchParams.get('page_size') ?? '50', 10) || 50));
    const offset = (page - 1) * pageSize;

    const sql = `SELECT * FROM ${safeIdent(name)} LIMIT ${pageSize} OFFSET ${offset}`;
    const v = validateSql(sql, projectId!);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

    try {
        const r = await runStatement(v.statements[0], {
            projectId: projectId!, userId: a.userId, toolName: 'rows_viewer',
        });
        if (r.kind !== 'query') return NextResponse.json({ error: 'Unexpected non-query result' }, { status: 500 });
        return NextResponse.json({
            table_name: name, rows: r.rows, page, page_size: pageSize, row_count: r.row_count,
        });
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal error' }, { status: 500 });
    }
}

// ── POST (insert) ───────────────────────────────────────────────────────

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ name: string }> },
) {
    const { name } = await params;
    if (!IDENT_RE.test(name)) return badTable();

    let body: { project_id?: string; values?: Record<string, unknown> };
    try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const a = await authFor(body.project_id ?? null);
    if (a.kind === 'err') return a.res;

    const values = body.values ?? {};
    const keys = Object.keys(values);
    if (keys.length === 0) return NextResponse.json({ error: 'values is required' }, { status: 400 });

    try {
        const cols = keys.map(safeIdent).join(', ');
        const vals = keys.map(k => safeLiteral(values[k])).join(', ');
        const sql = `INSERT INTO ${safeIdent(name)} (${cols}) VALUES (${vals})`;
        const v = validateSql(sql, body.project_id!);
        if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
        const r = await runStatement(v.statements[0], {
            projectId: body.project_id!, userId: a.userId, toolName: 'row_editor',
        });
        return NextResponse.json({ ok: true, row_count: r.row_count, duration_ms: r.duration_ms });
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Insert failed';
        const status = /Invalid|required|Non-finite/.test(msg) ? 400 : 500;
        return NextResponse.json({ error: msg }, { status });
    }
}

// ── PATCH (update by PK) ────────────────────────────────────────────────

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ name: string }> },
) {
    const { name } = await params;
    if (!IDENT_RE.test(name)) return badTable();

    let body: { project_id?: string; pk?: Record<string, unknown>; set?: Record<string, unknown> };
    try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const a = await authFor(body.project_id ?? null);
    if (a.kind === 'err') return a.res;

    const set = body.set ?? {};
    const setKeys = Object.keys(set);
    if (setKeys.length === 0) return NextResponse.json({ error: 'set is required' }, { status: 400 });

    try {
        const where = buildWhereByPk(body.pk);
        const setClause = setKeys.map(k => `${safeIdent(k)} = ${safeLiteral(set[k])}`).join(', ');
        const sql = `UPDATE ${safeIdent(name)} SET ${setClause} WHERE ${where}`;
        const v = validateSql(sql, body.project_id!);
        if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
        const r = await runStatement(v.statements[0], {
            projectId: body.project_id!, userId: a.userId, toolName: 'row_editor',
        });
        return NextResponse.json({ ok: true, row_count: r.row_count, duration_ms: r.duration_ms });
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Update failed';
        const status = /Invalid|required|cannot be null/.test(msg) ? 400 : 500;
        return NextResponse.json({ error: msg }, { status });
    }
}

// ── DELETE (by PK) ──────────────────────────────────────────────────────
//
// Body shape, not query string, because the PK can be a composite or carry
// values that don't survive URL encoding (json columns, booleans, etc.).
// Next.js allows DELETE with a JSON body since 13+.

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ name: string }> },
) {
    const { name } = await params;
    if (!IDENT_RE.test(name)) return badTable();

    let body: { project_id?: string; pk?: Record<string, unknown> };
    try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const a = await authFor(body.project_id ?? null);
    if (a.kind === 'err') return a.res;

    try {
        const where = buildWhereByPk(body.pk);
        const sql = `DELETE FROM ${safeIdent(name)} WHERE ${where}`;
        const v = validateSql(sql, body.project_id!);
        if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
        const r = await runStatement(v.statements[0], {
            projectId: body.project_id!, userId: a.userId, toolName: 'row_editor',
        });
        return NextResponse.json({ ok: true, row_count: r.row_count, duration_ms: r.duration_ms });
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Delete failed';
        const status = /Invalid|required|cannot be null/.test(msg) ? 400 : 500;
        return NextResponse.json({ error: msg }, { status });
    }
}
