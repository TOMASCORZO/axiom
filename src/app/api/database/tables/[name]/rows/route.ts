import { NextRequest, NextResponse } from 'next/server';
import { validateSql, runStatement } from '@/lib/game-db';
import { resolveProjectAuth } from '@/lib/game-db/auth';

export const maxDuration = 15;

// Identifier guard — Postgres lower-snake-case (matches create_game_table).
const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/i;

// GET /api/database/tables/[name]/rows?project_id=...&page=1&page_size=50
//
// Builds a parameterized SELECT * FROM "<table>" so the UI doesn't construct
// SQL itself. Goes through the same validator path as the SQL Console — keeps
// one audit trail, one safety net.
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ name: string }> },
) {
    const { name } = await params;
    if (!IDENT_RE.test(name)) {
        return NextResponse.json({ error: 'Invalid table name' }, { status: 400 });
    }

    const projectId = req.nextUrl.searchParams.get('project_id');
    if (!projectId) {
        return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    const page = Math.max(1, parseInt(req.nextUrl.searchParams.get('page') ?? '1', 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.nextUrl.searchParams.get('page_size') ?? '50', 10) || 50));
    const offset = (page - 1) * pageSize;

    const auth = await resolveProjectAuth(projectId);
    if ('status' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const sql = `SELECT * FROM "${name}" LIMIT ${pageSize} OFFSET ${offset}`;
    const v = validateSql(sql, projectId);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

    try {
        const r = await runStatement(v.statements[0], {
            projectId, userId: auth.userId, toolName: 'rows_viewer',
        });
        if (r.kind !== 'query') {
            return NextResponse.json({ error: 'Unexpected non-query result' }, { status: 500 });
        }
        return NextResponse.json({
            table_name: name,
            rows: r.rows,
            page,
            page_size: pageSize,
            row_count: r.row_count,
        });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Internal error' },
            { status: 500 },
        );
    }
}
