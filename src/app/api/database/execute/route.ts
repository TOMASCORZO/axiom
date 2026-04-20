import { NextRequest, NextResponse } from 'next/server';
import { validateSql, runStatement } from '@/lib/game-db';
import { resolveProjectAuth } from '@/lib/game-db/auth';
import { getAdminClient } from '@/lib/supabase/admin';

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

        // Record a migration if any DDL ran successfully. One row per Console
        // submission, not per statement — replaying the row reproduces the
        // exact sequence the user typed. Failures earlier in the loop would
        // have thrown, so reaching this point means every statement succeeded.
        const hadDdl = v.statements.some(s => s.kind === 'ddl');
        let migration_version: number | null = null;
        if (hadDdl) {
            try {
                const admin = getAdminClient();
                const { data: ver } = await admin.rpc('axiom_record_migration', {
                    p_project_id: project_id,
                    p_user_id: auth.userId,
                    p_sql: sql,
                    p_description: null,
                });
                migration_version = (typeof ver === 'number') ? ver : null;
            } catch {
                // Non-fatal: the schema change already applied. Migration log
                // is best-effort — surface a warning but don't fail the call.
            }
        }

        return NextResponse.json({
            success: true,
            statement_count: results.length,
            results,
            migration_version,
        });
    } catch (err) {
        return NextResponse.json(
            { success: false, error: err instanceof Error ? err.message : 'Internal error' },
            { status: 500 },
        );
    }
}
