/**
 * Schema introspection for the Database Studio UI and agent.
 *
 * Wraps the introspection RPCs from migration 007 so callers don't have to
 * deal with information_schema joins or the schema-name mapping.
 */

import { getAdminClient } from '@/lib/supabase/admin';

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

export interface GameTableSchema {
    columns: GameColumn[];
    primary_key: string[];
}

export async function listGameTables(projectId: string): Promise<GameTableSummary[]> {
    const admin = getAdminClient();
    const { data, error } = await admin.rpc('axiom_list_game_tables', { p_project_id: projectId });
    if (error) throw new Error(error.message);
    return (data ?? []) as GameTableSummary[];
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
    return (data ?? { columns: [], primary_key: [] }) as GameTableSchema;
}
