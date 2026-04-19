/**
 * SQL validator for the Database Studio.
 *
 * The RPCs in migration 007 run with elevated privileges (SECURITY DEFINER),
 * so the *only* thing standing between an attacker and `auth.users` is this
 * validator. Two layers of defense:
 *
 *   1. Statement-type allowlist — block CREATE EXTENSION, CREATE FUNCTION,
 *      DO blocks, COPY, GRANT, transactions, SET, etc.
 *   2. Schema-name check — walk every QName in the AST; reject any reference
 *      that names a schema other than the project's own game schema.
 *
 * pgsql-ast-parser is pure JS (no native deps, runs on Vercel). It also gives
 * us the statement kind so the API layer can route SELECTs to axiom_query and
 * everything else to axiom_exec.
 */

import { parse, type Statement } from 'pgsql-ast-parser';
import { gameSchemaName } from './schema';

export type StatementKind = 'query' | 'exec' | 'ddl';

export interface ValidatedStatement {
    sql: string;          // The single statement, trimmed
    ast: Statement;
    kind: StatementKind;
    isReadOnly: boolean;
}

export interface ValidationFailure {
    ok: false;
    error: string;
}

export interface ValidationSuccess {
    ok: true;
    statements: ValidatedStatement[];
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

// Statement.type values that are explicitly safe inside a game schema. Anything
// not in this set is rejected — defaulting to deny is the only sane posture
// here because pgsql-ast-parser may add new statement variants over time.
const ALLOWED_TYPES: ReadonlySet<string> = new Set([
    'select', 'union', 'union all', 'with', 'with recursive', 'values',
    'insert', 'update', 'delete',
    'create table', 'alter table',
    'drop table', 'drop index', 'drop sequence', 'drop type',
    'create index', 'alter index',
    'create sequence', 'alter sequence',
    'truncate table',
    'create enum', 'alter enum',
]);

// Tighter denylist so the failure message is actionable. Anything caught here
// would also fall through the allowlist, but the message is generic.
const EXPLICIT_DENY: Record<string, string> = {
    'create extension': 'CREATE EXTENSION is not allowed in game databases.',
    'create function': 'CREATE FUNCTION is not allowed (use the agent for stored logic).',
    'drop function': 'DROP FUNCTION is not allowed.',
    'drop trigger': 'DROP TRIGGER is not allowed (triggers are managed automatically).',
    'do': 'DO blocks (anonymous code) are not allowed.',
    'create schema': 'CREATE SCHEMA is not allowed — schemas are managed automatically.',
    'set global': 'SET / SHOW are not allowed.',
    'set timezone': 'SET / SHOW are not allowed.',
    'set names': 'SET / SHOW are not allowed.',
    'show': 'SET / SHOW are not allowed.',
    'tablespace': 'TABLESPACE statements are not allowed.',
    'create view': 'Views are disabled in v1 — use SELECT instead.',
    'create materialized view': 'Materialized views are disabled in v1.',
    'refresh materialized view': 'Materialized views are disabled in v1.',
    'commit': 'Explicit transaction control is not allowed.',
    'rollback': 'Explicit transaction control is not allowed.',
    'begin': 'Explicit transaction control is not allowed.',
    'start transaction': 'Explicit transaction control is not allowed.',
    'prepare': 'PREPARE is not allowed.',
    'deallocate': 'DEALLOCATE is not allowed.',
    'comment': 'COMMENT statements are not allowed.',
    'raise': 'RAISE is not allowed.',
};

// Statement types that read but don't mutate. Used by the agent's plan mode.
const READ_ONLY_TYPES: ReadonlySet<string> = new Set([
    'select', 'union', 'union all', 'with', 'with recursive', 'values',
]);

const QUERY_TYPES: ReadonlySet<string> = new Set([
    'select', 'union', 'union all', 'with', 'with recursive', 'values',
]);

const DDL_TYPES: ReadonlySet<string> = new Set([
    'create table', 'alter table',
    'drop table', 'drop index', 'drop sequence', 'drop type',
    'create index', 'alter index',
    'create sequence', 'alter sequence',
    'truncate table', 'create enum', 'alter enum',
]);

function statementKind(type: string): StatementKind {
    if (QUERY_TYPES.has(type)) return 'query';
    if (DDL_TYPES.has(type)) return 'ddl';
    return 'exec';
}

// Walk the AST recursively and collect every QName-shaped node ({ name,
// schema? }). Plain object walk is fine — the AST is JSON-safe.
function collectSchemaRefs(node: unknown, refs: string[]): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const item of node) collectSchemaRefs(item, refs);
        return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj.schema === 'string' && typeof obj.name === 'string') {
        refs.push(obj.schema);
    }
    for (const key of Object.keys(obj)) {
        if (key === '_location') continue;
        collectSchemaRefs(obj[key], refs);
    }
}

export function validateSql(sql: string, projectId: string): ValidationResult {
    const trimmed = sql.trim();
    if (!trimmed) return { ok: false, error: 'SQL is empty.' };

    let parsed: Statement[];
    try {
        parsed = parse(trimmed);
    } catch (err) {
        return {
            ok: false,
            error: `SQL parse error: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    if (parsed.length === 0) return { ok: false, error: 'No statements found.' };

    const allowedSchema = gameSchemaName(projectId);
    const statements: ValidatedStatement[] = [];

    for (const ast of parsed) {
        const type = ast.type;
        const denyMsg = EXPLICIT_DENY[type];
        if (denyMsg) return { ok: false, error: denyMsg };
        if (!ALLOWED_TYPES.has(type)) {
            return { ok: false, error: `Statement type "${type}" is not allowed in game databases.` };
        }

        // Cross-schema escape check: every QName.schema must be either unset
        // (resolves via search_path = game_<pid>) or exactly the game schema.
        const refs: string[] = [];
        collectSchemaRefs(ast, refs);
        for (const r of refs) {
            if (r !== allowedSchema) {
                return {
                    ok: false,
                    error: `Reference to schema "${r}" is not allowed. Only the project's own schema may be used.`,
                };
            }
        }

        statements.push({
            sql: trimmed,
            ast,
            kind: statementKind(type),
            isReadOnly: READ_ONLY_TYPES.has(type),
        });
    }

    return { ok: true, statements };
}
