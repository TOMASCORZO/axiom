/**
 * GET /api/database/export?project_id=...&format=sql
 * GET /api/database/export?project_id=...&format=csv&table=foo
 *
 * Returns a downloadable schema dump or per-table CSV. The Studio's Export
 * buttons call this directly; everything routes through axiom_query_in_game
 * so the export is recorded in the audit log.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectAuth } from '@/lib/game-db/auth';
import { gameSchemaName } from '@/lib/game-db/schema';
import { exportFullSql, exportTableCsv } from '@/lib/game-db/export';

export const maxDuration = 60;

const TABLE_RE = /^[a-z_][a-z0-9_]{0,62}$/i;

export async function GET(req: NextRequest) {
    const projectId = req.nextUrl.searchParams.get('project_id');
    const format = req.nextUrl.searchParams.get('format') ?? 'sql';
    const table = req.nextUrl.searchParams.get('table');

    if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    if (format !== 'sql' && format !== 'csv') {
        return NextResponse.json({ error: 'format must be sql or csv' }, { status: 400 });
    }
    if (format === 'csv' && (!table || !TABLE_RE.test(table))) {
        return NextResponse.json({ error: 'csv export requires a valid table name' }, { status: 400 });
    }

    const auth = await resolveProjectAuth(projectId);
    if ('status' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    try {
        if (format === 'sql') {
            const body = await exportFullSql(
                { projectId, userId: auth.userId },
                gameSchemaName(projectId),
            );
            return new NextResponse(body, {
                status: 200,
                headers: {
                    'Content-Type': 'application/sql; charset=utf-8',
                    'Content-Disposition': `attachment; filename="axiom-${projectId}.sql"`,
                },
            });
        }
        const body = await exportTableCsv(
            { projectId, userId: auth.userId },
            table!,
        );
        return new NextResponse(body, {
            status: 200,
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="${table}.csv"`,
            },
        });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Export failed' },
            { status: 500 },
        );
    }
}
