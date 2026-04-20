/**
 * Schema introspection for the Database Studio UI and agent.
 *
 * Wraps the introspection RPCs from migration 007 so callers don't have to
 * deal with information_schema joins or the schema-name mapping.
 *
 * FK / index metadata isn't covered by the existing RPCs — those are queried
 * directly against information_schema + pg_indexes with a single-schema filter
 * via the axiom_query_in_game RPC, the same pattern export.ts uses.
 */

import { getAdminClient } from '@/lib/supabase/admin';
import { gameSchemaName } from './schema';
import { safeLiteral } from './literals';

export interface GameTableSummary {
    name: string;
    row_count: number;
}

export interface GameColumn {
    name: string;
    type: string;
    nullable: boolean;
    default: string | null;
}

export interface ForeignKey {
    name: string;
    columns: string[];
    ref_table: string;
    ref_columns: string[];
    on_delete: 'NO ACTION' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT';
    on_update: 'NO ACTION' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT';
}

export interface TableIndex {
    name: string;
    columns: string[];
    unique: boolean;
    primary: boolean;
}

export interface GameTableSchema {
    columns: GameColumn[];
    primary_key: string[];
    foreign_keys: ForeignKey[];
    indexes: TableIndex[];
}

export async function listGameTables(projectId: string): Promise<GameTableSummary[]> {
    const admin = getAdminClient();
    const { data, error } = await admin.rpc('axiom_list_game_tables', { p_project_id: projectId });
    if (error) throw new Error(error.message);
    return (data ?? []) as GameTableSummary[];
}

// Introspection that isn't worth another Postgres RPC — runs information_schema
// / pg_indexes lookups through the existing axiom_query_in_game pipeline, which
// pins search_path so unqualified references resolve safely.
async function runIntrospection(
    projectId: string,
    sql: string,
): Promise<Record<string, unknown>[]> {
    const admin = getAdminClient();
    const { data, error } = await admin.rpc('axiom_query_in_game', {
        p_project_id: projectId,
        p_user_id: projectId, // introspection isn't user-attributed; schema id is fine
        p_tool_name: 'introspect',
        p_sql: sql,
    });
    if (error) throw new Error(error.message);
    const result = data as { rows?: Record<string, unknown>[] };
    return result.rows ?? [];
}

async function loadForeignKeys(projectId: string, schemaName: string, tableName: string): Promise<ForeignKey[]> {
    const sql = `
        SELECT tc.constraint_name AS name,
               array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS columns,
               (array_agg(ccu.table_name))[1] AS ref_table,
               array_agg(ccu.column_name ORDER BY kcu.ordinal_position) AS ref_columns,
               (array_agg(rc.delete_rule))[1] AS on_delete,
               (array_agg(rc.update_rule))[1] AS on_update
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON tc.constraint_name = ccu.constraint_name
           AND tc.table_schema = ccu.table_schema
          JOIN information_schema.referential_constraints rc
            ON tc.constraint_name = rc.constraint_name
           AND tc.table_schema = rc.constraint_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = ${safeLiteral(schemaName)}
           AND tc.table_name = ${safeLiteral(tableName)}
         GROUP BY tc.constraint_name
         ORDER BY tc.constraint_name
    `;
    const rows = await runIntrospection(projectId, sql);
    return rows.map(r => ({
        name: String(r.name),
        columns: Array.isArray(r.columns) ? r.columns.map(String) : [],
        ref_table: String(r.ref_table),
        ref_columns: Array.isArray(r.ref_columns) ? r.ref_columns.map(String) : [],
        on_delete: String(r.on_delete ?? 'NO ACTION') as ForeignKey['on_delete'],
        on_update: String(r.on_update ?? 'NO ACTION') as ForeignKey['on_update'],
    }));
}

async function loadIndexes(projectId: string, schemaName: string, tableName: string): Promise<TableIndex[]> {
    const sql = `
        SELECT i.relname AS name,
               idx.indisunique AS is_unique,
               idx.indisprimary AS is_primary,
               array_agg(a.attname ORDER BY array_position(idx.indkey::int[], a.attnum)) AS columns
          FROM pg_index idx
          JOIN pg_class i ON i.oid = idx.indexrelid
          JOIN pg_class t ON t.oid = idx.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(idx.indkey)
         WHERE n.nspname = ${safeLiteral(schemaName)}
           AND t.relname = ${safeLiteral(tableName)}
         GROUP BY i.relname, idx.indisunique, idx.indisprimary
         ORDER BY idx.indisprimary DESC, i.relname
    `;
    const rows = await runIntrospection(projectId, sql);
    return rows.map(r => ({
        name: String(r.name),
        columns: Array.isArray(r.columns) ? r.columns.map(String) : [],
        unique: Boolean(r.is_unique),
        primary: Boolean(r.is_primary),
    }));
}

export async function describeGameTable(
    projectId: string,
    tableName: string,
): Promise<GameTableSchema> {
    const admin = getAdminClient();
    const { data, error } = await admin.rpc('axiom_describe_game_table', {
        p_project_id: projectId,
        p_table_name: tableName,
    });
    if (error) throw new Error(error.message);
    const base = (data ?? { columns: [], primary_key: [] }) as { columns: GameColumn[]; primary_key: string[] };

    const schemaName = gameSchemaName(projectId);
    const [foreign_keys, indexes] = await Promise.all([
        loadForeignKeys(projectId, schemaName, tableName).catch(() => []),
        loadIndexes(projectId, schemaName, tableName).catch(() => []),
    ]);

    return { ...base, foreign_keys, indexes };
}
