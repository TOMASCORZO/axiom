/**
 * Game-database executor.
 *
 * Wraps the SECURITY DEFINER RPCs from migration 007. The validator must run
 * before this — these helpers do NOT re-check SQL safety. Always:
 *
 *   const v = validateSql(sql, projectId);
 *   if (!v.ok) return error(v.error);
 *   for (const s of v.statements) await runStatement(s, ctx);
 *
 * Returns a normalized shape regardless of statement kind so the API and the
 * agent tools can render results uniformly.
 */

import { getAdminClient } from '@/lib/supabase/admin';
import type { ValidatedStatement } from './validator';

export interface QueryResult {
    kind: 'query';
    rows: Record<string, unknown>[];
    row_count: number;
    duration_ms: number;
}

export interface ExecResult {
    kind: 'exec' | 'ddl';
    row_count: number;
    duration_ms: number;
}

export type StatementResult = QueryResult | ExecResult;

interface RunContext {
    projectId: string;
    userId: string;
    toolName: string;
}

export async function runStatement(
    stmt: ValidatedStatement,
    ctx: RunContext,
): Promise<StatementResult> {
    const admin = getAdminClient();

    if (stmt.kind === 'query') {
        const { data, error } = await admin.rpc('axiom_query_in_game', {
            p_project_id: ctx.projectId,
            p_user_id: ctx.userId,
            p_tool_name: ctx.toolName,
            p_sql: stmt.sql,
        });
        if (error) throw new Error(error.message);
        const result = data as { rows: Record<string, unknown>[]; row_count: number; duration_ms: number };
        return {
            kind: 'query',
            rows: result.rows ?? [],
            row_count: result.row_count ?? 0,
            duration_ms: result.duration_ms ?? 0,
        };
    }

    const { data, error } = await admin.rpc('axiom_exec_in_game', {
        p_project_id: ctx.projectId,
        p_user_id: ctx.userId,
        p_tool_name: ctx.toolName,
        p_sql: stmt.sql,
        p_kind: stmt.kind,
    });
    if (error) throw new Error(error.message);
    const result = data as { row_count: number; duration_ms: number };
    return {
        kind: stmt.kind,
        row_count: result.row_count ?? 0,
        duration_ms: result.duration_ms ?? 0,
    };
}
