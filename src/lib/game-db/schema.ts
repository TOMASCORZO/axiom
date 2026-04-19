/**
 * Deterministic mapping from a project UUID to its dedicated Postgres schema.
 *
 * Mirrors the SQL function `public.axiom_game_schema(uuid)` exactly — keep
 * them in sync. Both replace hyphens with underscores so the result is a valid
 * unquoted Postgres identifier.
 */
export function gameSchemaName(projectId: string): string {
    return `game_${projectId.replace(/-/g, '_')}`;
}
