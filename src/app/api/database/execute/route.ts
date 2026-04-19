import { NextRequest, NextResponse } from 'next/server';
import { validateSql, runStatement } from '@/lib/game-db';
import { resolveProjectAuth } from '@/lib/game-db/auth';

export const maxDuration = 30;

// POST /api/database/execute — run validated SQL against the project schema.
// Used by the SQL Console (UI) and as a fallback path for the agent.
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { project_id, sql, limit = 200 } = body as {
            project_id?: string; sql?: string; limit?: number;
        };
        if (!project_id || !sql) {
            return NextResponse.json({ error: 'project_id and sql are required' }, { status: 400 });
        }

        const auth = await resolveProjectAuth(project_id);
        if ('status' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

        const v = validateSql(sql, project_id);
        if (!v.ok) {
            return NextResponse.json({ success: false, validation_error: v.error }, { status: 400 });
        }

        const results = [];
        for (const stmt of v.statements) {
            const r = await runStatement(stmt, {
                projectId: project_id, userId: auth.userId, toolName: 'sql_console',
            });
            if (r.kind === 'query') {
                results.push({
                    kind: 'query',
                    rows: r.rows.slice(0, limit),
                    truncated: r.rows.length > limit,
                    row_count: r.row_count,
                    duration_ms: r.duration_ms,
                });
            } else {
                results.push({
                    kind: r.kind,
                    row_count: r.row_count,
                    duration_ms: r.duration_ms,
                });
            }
        }

        return NextResponse.json({
            success: true,
            statement_count: results.length,
            results,
        });
    } catch (err) {
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : 'Internal error' },
            { status: 500 },
        );
    }
}
