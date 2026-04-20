/**
 * Database Studio tools — let the agent define and query a per-game schema.
 *
 *   - list_game_tables       Tables in this project's schema with row counts.
 *   - describe_game_table    Columns / types / PK for a single table.
 *   - create_game_table      Builds a safe CREATE TABLE from a structured
 *                            column spec (preferred over raw SQL for setup).
 *   - execute_game_sql       Fallback for anything the structured tools don't
 *                            cover (joins, conditional updates, etc.). The
 *                            validator gates dangerous statements.
 *
 * All execution funnels through the SECURITY DEFINER RPCs in migration 007,
 * which pin search_path to the project schema and write an audit row.
 */

import { registerTool, type ToolContext, type ToolInput } from './registry';
import {
    validateSql,
    runStatement,
    listGameTables,
    describeGameTable,
} from '@/lib/game-db';

// ── Postgres type allowlist ───────────────────────────────────────────
//
// We intentionally don't accept arbitrary type strings — the agent could
// otherwise pass `text CHECK (foo())` and smuggle expressions. The user can
// drop to execute_game_sql for exotic types.
const ALLOWED_COL_TYPES: ReadonlySet<string> = new Set([
    'text', 'varchar',
    'int', 'integer', 'bigint', 'smallint',
    'real', 'double precision', 'numeric',
    'boolean', 'bool',
    'uuid',
    'jsonb', 'json',
    'timestamptz', 'timestamp', 'date', 'time',
    'bytea',
]);

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/i;

function quoteIdent(name: string): string {
    if (!IDENT_RE.test(name)) {
        throw new Error(`Invalid identifier "${name}" — must match /^[a-z_][a-z0-9_]{0,62}$/i.`);
    }
    return `"${name}"`;
}

interface ColumnSpec {
    name: string;
    type: string;
    nullable?: boolean;
    primary_key?: boolean;
    default?: string | number | boolean | null;
    unique?: boolean;
}

function buildColumnDef(col: ColumnSpec): string {
    const ident = quoteIdent(col.name);
    const type = col.type.toLowerCase().trim();
    if (!ALLOWED_COL_TYPES.has(type)) {
        throw new Error(`Column type "${col.type}" not allowed. Allowed: ${Array.from(ALLOWED_COL_TYPES).join(', ')}.`);
    }
    const parts = [ident, type];
    if (col.primary_key) parts.push('PRIMARY KEY');
    if (col.unique && !col.primary_key) parts.push('UNIQUE');
    if (col.nullable === false && !col.primary_key) parts.push('NOT NULL');
    if (col.default !== undefined) {
        // Whitelist a few safe default forms. Anything else falls through to
        // a literal — quoted via $$..$$ so the agent can't break out.
        const d = col.default;
        if (d === null) parts.push('DEFAULT NULL');
        else if (typeof d === 'boolean') parts.push(`DEFAULT ${d ? 'TRUE' : 'FALSE'}`);
        else if (typeof d === 'number' && Number.isFinite(d)) parts.push(`DEFAULT ${d}`);
        else if (typeof d === 'string') {
            const lower = d.toLowerCase();
            if (lower === 'now()' || lower === 'gen_random_uuid()' || lower === 'current_timestamp') {
                parts.push(`DEFAULT ${lower}`);
            } else {
                // Dollar-quote with a random tag the user can't pre-escape.
                const tag = `dq${Math.random().toString(36).slice(2, 8)}`;
                parts.push(`DEFAULT $${tag}$${d}$${tag}$`);
            }
        }
    }
    return parts.join(' ');
}

// ── list_game_tables ──────────────────────────────────────────────────

registerTool({
    name: 'list_game_tables',
    description: 'List all tables in this project\'s game database, with row counts. Use this first to see what\'s already defined before creating new tables.',
    parameters: {
        type: 'object',
        properties: {},
        required: [],
    },
    access: ['build', 'plan', 'explore'],
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(ctx: ToolContext) {
        const start = Date.now();
        try {
            const tables = await listGameTables(ctx.projectId);
            return {
                callId: '', success: true,
                output: {
                    table_count: tables.length,
                    tables,
                    message: tables.length === 0
                        ? 'Game database is empty — no tables defined yet.'
                        : `${tables.length} table(s) in game database.`,
                },
                duration_ms: Date.now() - start,
            };
        } catch (err) {
            return {
                callId: '', success: false,
                output: {},
                error: err instanceof Error ? err.message : 'Failed to list tables',
                duration_ms: Date.now() - start,
            };
        }
    },
});

// ── describe_game_table ───────────────────────────────────────────────

registerTool({
    name: 'describe_game_table',
    description: 'Show the schema of one table in the game database: columns, types, nullability, defaults, primary key. Use before writing INSERT/UPDATE statements.',
    parameters: {
        type: 'object',
        properties: {
            table_name: { type: 'string', description: 'Table name (without schema prefix).' },
        },
        required: ['table_name'],
    },
    access: ['build', 'plan', 'explore'],
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(ctx: ToolContext, input: ToolInput) {
        const start = Date.now();
        const tableName = input.table_name as string;
        try {
            // Sanity-check the name before round-tripping to Postgres so a bad
            // call returns a clean error instead of a SQL exception.
            quoteIdent(tableName);
            const schema = await describeGameTable(ctx.projectId, tableName);
            return {
                callId: '', success: true,
                output: {
                    table_name: tableName,
                    ...schema,
                    message: `Table "${tableName}" has ${schema.columns.length} column(s).`,
                },
                duration_ms: Date.now() - start,
            };
        } catch (err) {
            return {
                callId: '', success: false,
                output: {},
                error: err instanceof Error ? err.message : 'Failed to describe table',
                duration_ms: Date.now() - start,
            };
        }
    },
});

// ── create_game_table ─────────────────────────────────────────────────

registerTool({
    name: 'create_game_table',
    description: 'Create a new table in the game database. Builds a safe CREATE TABLE from a structured column spec — prefer this over raw SQL for table setup. Each column needs name + type. Optional: nullable (default true), primary_key, unique, default (literal value or one of: now(), gen_random_uuid(), current_timestamp).',
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Table name. Lowercase letters, digits, underscore.' },
            if_not_exists: { type: 'boolean', default: true },
            columns: {
                type: 'array',
                description: 'At least one column. The first column with primary_key=true becomes the PRIMARY KEY.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        type: {
                            type: 'string',
                            description: 'Postgres type. Allowed: text, varchar, int, integer, bigint, smallint, real, double precision, numeric, boolean, bool, uuid, jsonb, json, timestamptz, timestamp, date, time, bytea.',
                        },
                        nullable: { type: 'boolean', default: true },
                        primary_key: { type: 'boolean', default: false },
                        unique: { type: 'boolean', default: false },
                        default: { description: 'Literal default. Use the string "now()" / "gen_random_uuid()" / "current_timestamp" for function defaults.' },
                    },
                    required: ['name', 'type'],
                },
            },
        },
        required: ['name', 'columns'],
    },
    access: ['build'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const start = Date.now();
        const tableName = input.name as string;
        const ifNotExists = input.if_not_exists !== false;
        const cols = input.columns as ColumnSpec[];
        try {
            if (!Array.isArray(cols) || cols.length === 0) {
                throw new Error('At least one column is required.');
            }
            const tableIdent = quoteIdent(tableName);
            const colDefs = cols.map(buildColumnDef).join(', ');
            const sql = `CREATE TABLE${ifNotExists ? ' IF NOT EXISTS' : ''} ${tableIdent} (${colDefs})`;

            // Round-trip through the validator — this exercises the same safety
            // net the user-typed SQL goes through, so create_game_table can
            // never bypass the global guarantees by accident.
            const v = validateSql(sql, ctx.projectId);
            if (!v.ok) throw new Error(`Generated SQL failed validation: ${v.error}`);

            const result = await runStatement(v.statements[0], {
                projectId: ctx.projectId, userId: ctx.userId, toolName: 'create_game_table',
            });
            return {
                callId: '', success: true,
                output: {
                    table: tableName,
                    sql,
                    duration_ms: result.duration_ms,
                    message: `Table "${tableName}" created with ${cols.length} column(s).`,
                },
                duration_ms: Date.now() - start,
            };
        } catch (err) {
            return {
                callId: '', success: false,
                output: { table: tableName },
                error: err instanceof Error ? err.message : 'Failed to create table',
                duration_ms: Date.now() - start,
            };
        }
    },
});

// ── add_column ────────────────────────────────────────────────────────

registerTool({
    name: 'add_column',
    description:
        'Add a single column to an existing game table. Use instead of execute_game_sql for schema edits. ' +
        'Uses the same type allowlist as create_game_table. Cannot add a PRIMARY KEY column — create the table with it instead.',
    parameters: {
        type: 'object',
        properties: {
            table_name: { type: 'string', description: 'Table to modify.' },
            column: {
                type: 'object',
                description: 'Column spec: { name, type, nullable?, unique?, default? }.',
                properties: {
                    name: { type: 'string' },
                    type: {
                        type: 'string',
                        description: 'Allowed: text, varchar, int, integer, bigint, smallint, real, double precision, numeric, boolean, bool, uuid, jsonb, json, timestamptz, timestamp, date, time, bytea.',
                    },
                    nullable: { type: 'boolean', default: true },
                    unique: { type: 'boolean', default: false },
                    default: { description: 'Literal default, or "now()" / "gen_random_uuid()" / "current_timestamp".' },
                },
                required: ['name', 'type'],
            },
        },
        required: ['table_name', 'column'],
    },
    access: ['build'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const start = Date.now();
        const tableName = input.table_name as string;
        const col = input.column as ColumnSpec;
        try {
            if (col.primary_key) {
                throw new Error('Adding a PRIMARY KEY column after table creation is not supported. Re-create the table instead.');
            }
            const tableIdent = quoteIdent(tableName);
            const colDef = buildColumnDef(col);
            const sql = `ALTER TABLE ${tableIdent} ADD COLUMN IF NOT EXISTS ${colDef}`;
            const v = validateSql(sql, ctx.projectId);
            if (!v.ok) throw new Error(`Generated SQL failed validation: ${v.error}`);
            const r = await runStatement(v.statements[0], {
                projectId: ctx.projectId, userId: ctx.userId, toolName: 'add_column',
            });
            return {
                callId: '', success: true,
                output: { table: tableName, column: col.name, sql, message: `Column "${col.name}" added to "${tableName}".`, duration_ms: r.duration_ms },
                duration_ms: Date.now() - start,
            };
        } catch (err) {
            return {
                callId: '', success: false,
                output: { table: tableName },
                error: err instanceof Error ? err.message : 'add_column failed',
                duration_ms: Date.now() - start,
            };
        }
    },
});

// ── drop_column ───────────────────────────────────────────────────────

registerTool({
    name: 'drop_column',
    description:
        'Drop a column from a game table. Destructive — the column\'s data is gone. Cannot drop a PRIMARY KEY column.',
    parameters: {
        type: 'object',
        properties: {
            table_name: { type: 'string' },
            column_name: { type: 'string' },
            if_exists: { type: 'boolean', default: true },
        },
        required: ['table_name', 'column_name'],
    },
    access: ['build'],
    isDestructive: true,
    async execute(ctx: ToolContext, input: ToolInput) {
        const start = Date.now();
        const tableName = input.table_name as string;
        const columnName = input.column_name as string;
        const ifExists = input.if_exists !== false;
        try {
            const sql = `ALTER TABLE ${quoteIdent(tableName)} DROP COLUMN${ifExists ? ' IF EXISTS' : ''} ${quoteIdent(columnName)}`;
            const v = validateSql(sql, ctx.projectId);
            if (!v.ok) throw new Error(`Generated SQL failed validation: ${v.error}`);
            const r = await runStatement(v.statements[0], {
                projectId: ctx.projectId, userId: ctx.userId, toolName: 'drop_column',
            });
            return {
                callId: '', success: true,
                output: { table: tableName, column: columnName, sql, message: `Column "${columnName}" dropped from "${tableName}".`, duration_ms: r.duration_ms },
                duration_ms: Date.now() - start,
            };
        } catch (err) {
            return {
                callId: '', success: false,
                output: { table: tableName, column: columnName },
                error: err instanceof Error ? err.message : 'drop_column failed',
                duration_ms: Date.now() - start,
            };
        }
    },
});

// ── rename_column ─────────────────────────────────────────────────────

registerTool({
    name: 'rename_column',
    description: 'Rename a column on a game table.',
    parameters: {
        type: 'object',
        properties: {
            table_name: { type: 'string' },
            from: { type: 'string', description: 'Current column name.' },
            to: { type: 'string', description: 'New column name.' },
        },
        required: ['table_name', 'from', 'to'],
    },
    access: ['build'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const start = Date.now();
        const tableName = input.table_name as string;
        const from = input.from as string;
        const to = input.to as string;
        try {
            const sql = `ALTER TABLE ${quoteIdent(tableName)} RENAME COLUMN ${quoteIdent(from)} TO ${quoteIdent(to)}`;
            const v = validateSql(sql, ctx.projectId);
            if (!v.ok) throw new Error(`Generated SQL failed validation: ${v.error}`);
            const r = await runStatement(v.statements[0], {
                projectId: ctx.projectId, userId: ctx.userId, toolName: 'rename_column',
            });
            return {
                callId: '', success: true,
                output: { table: tableName, from, to, sql, message: `Column "${from}" → "${to}" on "${tableName}".`, duration_ms: r.duration_ms },
                duration_ms: Date.now() - start,
            };
        } catch (err) {
            return {
                callId: '', success: false,
                output: { table: tableName, from, to },
                error: err instanceof Error ? err.message : 'rename_column failed',
                duration_ms: Date.now() - start,
            };
        }
    },
});

// ── alter_column ──────────────────────────────────────────────────────

registerTool({
    name: 'alter_column',
    description:
        'Change a column\'s type, nullability, or default. One change per call. Cast failures during a type change abort the statement.',
    parameters: {
        type: 'object',
        properties: {
            table_name: { type: 'string' },
            column_name: { type: 'string' },
            op: {
                type: 'string',
                enum: ['set_type', 'set_nullable', 'set_default', 'drop_default'],
                description:
                    'set_type (pair with type + optional using), set_nullable (pair with nullable), set_default (pair with default), drop_default.',
            },
            type: { type: 'string', description: 'New Postgres type for set_type. Same allowlist as create_game_table.' },
            using: { type: 'string', description: 'Optional USING expression for set_type (e.g. "col::int").' },
            nullable: { type: 'boolean', description: 'For set_nullable.' },
            default: { description: 'For set_default — literal or one of now() / gen_random_uuid() / current_timestamp.' },
        },
        required: ['table_name', 'column_name', 'op'],
    },
    access: ['build'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const start = Date.now();
        const tableName = input.table_name as string;
        const columnName = input.column_name as string;
        const op = input.op as 'set_type' | 'set_nullable' | 'set_default' | 'drop_default';
        try {
            const tbl = quoteIdent(tableName);
            const col = quoteIdent(columnName);
            let clause: string;

            switch (op) {
                case 'set_type': {
                    const newType = (input.type as string | undefined)?.toLowerCase().trim();
                    if (!newType) throw new Error('set_type requires `type`');
                    if (!ALLOWED_COL_TYPES.has(newType)) {
                        throw new Error(`Column type "${newType}" not allowed. Allowed: ${Array.from(ALLOWED_COL_TYPES).join(', ')}.`);
                    }
                    // USING expression is validated by running the full ALTER through
                    // the SQL validator below. Anything that references another schema
                    // or a denied function surface gets rejected there.
                    const using = input.using as string | undefined;
                    clause = `ALTER COLUMN ${col} TYPE ${newType}${using ? ` USING ${using}` : ''}`;
                    break;
                }
                case 'set_nullable': {
                    if (typeof input.nullable !== 'boolean') throw new Error('set_nullable requires `nullable`');
                    clause = `ALTER COLUMN ${col} ${input.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`;
                    break;
                }
                case 'set_default': {
                    const d = input.default;
                    let lit: string;
                    if (d === null) lit = 'NULL';
                    else if (typeof d === 'boolean') lit = d ? 'TRUE' : 'FALSE';
                    else if (typeof d === 'number' && Number.isFinite(d)) lit = String(d);
                    else if (typeof d === 'string') {
                        const lower = d.toLowerCase();
                        if (lower === 'now()' || lower === 'gen_random_uuid()' || lower === 'current_timestamp') {
                            lit = lower;
                        } else {
                            const tag = `dq${Math.random().toString(36).slice(2, 8)}`;
                            lit = `$${tag}$${d}$${tag}$`;
                        }
                    } else {
                        throw new Error('set_default requires a primitive or supported function string');
                    }
                    clause = `ALTER COLUMN ${col} SET DEFAULT ${lit}`;
                    break;
                }
                case 'drop_default':
                    clause = `ALTER COLUMN ${col} DROP DEFAULT`;
                    break;
            }

            const sql = `ALTER TABLE ${tbl} ${clause}`;
            const v = validateSql(sql, ctx.projectId);
            if (!v.ok) throw new Error(`Generated SQL failed validation: ${v.error}`);
            const r = await runStatement(v.statements[0], {
                projectId: ctx.projectId, userId: ctx.userId, toolName: 'alter_column',
            });
            return {
                callId: '', success: true,
                output: { table: tableName, column: columnName, op, sql, message: `Column "${columnName}" on "${tableName}" altered (${op}).`, duration_ms: r.duration_ms },
                duration_ms: Date.now() - start,
            };
        } catch (err) {
            return {
                callId: '', success: false,
                output: { table: tableName, column: columnName, op },
                error: err instanceof Error ? err.message : 'alter_column failed',
                duration_ms: Date.now() - start,
            };
        }
    },
});

// ── add_foreign_key ───────────────────────────────────────────────────

const FK_ACTIONS: ReadonlySet<string> = new Set([
    'NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT',
]);

function normalizeFkAction(a: unknown, field: string): string {
    if (a == null) return 'NO ACTION';
    const up = String(a).toUpperCase().trim();
    if (!FK_ACTIONS.has(up)) throw new Error(`Invalid ${field}: ${a}`);
    return up;
}

registerTool({
    name: 'add_foreign_key',
    description: 'Add a foreign key constraint on an existing table. Reference must point at another table in the same game schema.',
    isDestructive: false,
    access: ['build'],
    parameters: {
        type: 'object',
        required: ['table', 'columns', 'ref_table', 'ref_columns'],
        properties: {
            table: { type: 'string', description: 'Table to add the FK on.' },
            columns: { type: 'array', items: { type: 'string' }, description: 'Local column(s) that reference the parent.' },
            ref_table: { type: 'string', description: 'Referenced (parent) table.' },
            ref_columns: { type: 'array', items: { type: 'string' }, description: 'Referenced column(s); must match columns[] length.' },
            name: { type: 'string', description: 'Optional constraint name. Defaults to <table>_<cols>_fkey.' },
            on_delete: { type: 'string', description: 'ON DELETE action. Default NO ACTION.', enum: ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT'] },
            on_update: { type: 'string', description: 'ON UPDATE action. Default NO ACTION.', enum: ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT'] },
        },
    },
    async execute(ctx: ToolContext, input: ToolInput) {
        const start = Date.now();
        const tableName = String(input.table ?? '');
        try {
            const cols = Array.isArray(input.columns) ? (input.columns as unknown[]).map(String) : [];
            const refCols = Array.isArray(input.ref_columns) ? (input.ref_columns as unknown[]).map(String) : [];
            const refTable = String(input.ref_table ?? '');
            if (!tableName || cols.length === 0) throw new Error('table and columns[] are required');
            if (!refTable || refCols.length !== cols.length) throw new Error('ref_table and matching ref_columns[] are required');

            const onDelete = normalizeFkAction(input.on_delete, 'on_delete');
            const onUpdate = normalizeFkAction(input.on_update, 'on_update');
            const constraintName = input.name ? String(input.name) : `${tableName}_${cols.join('_')}_fkey`;

            const sql =
                `ALTER TABLE ${quoteIdent(tableName)} ` +
                `ADD CONSTRAINT ${quoteIdent(constraintName)} ` +
                `FOREIGN KEY (${cols.map(quoteIdent).join(', ')}) ` +
                `REFERENCES ${quoteIdent(refTable)} (${refCols.map(quoteIdent).join(', ')}) ` +
                `ON DELETE ${onDelete} ON UPDATE ${onUpdate}`;

            const v = validateSql(sql, ctx.projectId);
            if (!v.ok) throw new Error(`Generated SQL failed validation: ${v.error}`);
            const r = await runStatement(v.statements[0], {
                projectId: ctx.projectId, userId: ctx.userId, toolName: 'add_foreign_key',
            });
            return {
                callId: '', success: true,
                output: { table: tableName, name: constraintName, sql, message: `FK "${constraintName}" added to "${tableName}".`, duration_ms: r.duration_ms },
                duration_ms: Date.now() - start,
            };
        } catch (err) {
            return {
                callId: '', success: false,
                output: { table: tableName },
                error: err instanceof Error ? err.message : 'add_foreign_key failed',
                duration_ms: Date.now() - start,
            };
        }
    },
});

// ── drop_foreign_key ──────────────────────────────────────────────────

registerTool({
    name: 'drop_foreign_key',
    description: 'Drop a foreign key constraint by name.',
    isDestructive: true,
    access: ['build'],
    parameters: {
        type: 'object',
        required: ['table', 'constraint_name'],
        properties: {
            table: { type: 'string' },
            constraint_name: { type: 'string' },
        },
    },
    async execute(ctx: ToolContext, input: ToolInput) {
        const start = Date.now();
        const tableName = String(input.table ?? '');
        const constraintName = String(input.constraint_name ?? '');
        try {
            if (!tableName || !constraintName) throw new Error('table and constraint_name are required');
            const sql = `ALTER TABLE ${quoteIdent(tableName)} DROP CONSTRAINT IF EXISTS ${quoteIdent(constraintName)}`;
            const v = validateSql(sql, ctx.projectId);
            if (!v.ok) throw new Error(`Generated SQL failed validation: ${v.error}`);
            const r = await runStatement(v.statements[0], {
                projectId: ctx.projectId, userId: ctx.userId, toolName: 'drop_foreign_key',
            });
            return {
                callId: '', success: true,
                output: { table: tableName, name: constraintName, sql, message: `FK "${constraintName}" dropped.`, duration_ms: r.duration_ms },
                duration_ms: Date.now() - start,
            };
        } catch (err) {
            return {
                callId: '', success: false,
                output: { table: tableName, name: constraintName },
                error: err instanceof Error ? err.message : 'drop_foreign_key failed',
                duration_ms: Date.now() - start,
            };
        }
    },
});

// ── create_index ──────────────────────────────────────────────────────

registerTool({
    name: 'create_index',
    description: 'Create an index (optionally UNIQUE) on one or more columns. Uses IF NOT EXISTS so repeated calls are safe.',
    isDestructive: false,
    access: ['build'],
    parameters: {
        type: 'object',
        required: ['table', 'columns'],
        properties: {
            table: { type: 'string' },
            columns: { type: 'array', items: { type: 'string' } },
            unique: { type: 'boolean', description: 'Create a UNIQUE index. Default false.' },
            name: { type: 'string', description: 'Optional index name. Defaults to <table>_<cols>_idx.' },
        },
    },
    async execute(ctx: ToolContext, input: ToolInput) {
        const start = Date.now();
        const tableName = String(input.table ?? '');
        try {
            const cols = Array.isArray(input.columns) ? (input.columns as unknown[]).map(String) : [];
            if (!tableName || cols.length === 0) throw new Error('table and columns[] are required');
            const unique = Boolean(input.unique);
            const indexName = input.name ? String(input.name) : `${tableName}_${cols.join('_')}_idx`;
            const sql =
                `CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quoteIdent(indexName)} ` +
                `ON ${quoteIdent(tableName)} (${cols.map(quoteIdent).join(', ')})`;
            const v = validateSql(sql, ctx.projectId);
            if (!v.ok) throw new Error(`Generated SQL failed validation: ${v.error}`);
            const r = await runStatement(v.statements[0], {
                projectId: ctx.projectId, userId: ctx.userId, toolName: 'create_index',
            });
            return {
                callId: '', success: true,
                output: { table: tableName, name: indexName, unique, sql, message: `Index "${indexName}" on "${tableName}" created.`, duration_ms: r.duration_ms },
                duration_ms: Date.now() - start,
            };
        } catch (err) {
            return {
                callId: '', success: false,
                output: { table: tableName },
                error: err instanceof Error ? err.message : 'create_index failed',
                duration_ms: Date.now() - start,
            };
        }
    },
});

// ── drop_index ────────────────────────────────────────────────────────

registerTool({
    name: 'drop_index',
    description: 'Drop an index by name.',
    isDestructive: true,
    access: ['build'],
    parameters: {
        type: 'object',
        required: ['index_name'],
        properties: {
            index_name: { type: 'string' },
        },
    },
    async execute(ctx: ToolContext, input: ToolInput) {
        const start = Date.now();
        const indexName = String(input.index_name ?? '');
        try {
            if (!indexName) throw new Error('index_name is required');
            const sql = `DROP INDEX IF EXISTS ${quoteIdent(indexName)}`;
            const v = validateSql(sql, ctx.projectId);
            if (!v.ok) throw new Error(`Generated SQL failed validation: ${v.error}`);
            const r = await runStatement(v.statements[0], {
                projectId: ctx.projectId, userId: ctx.userId, toolName: 'drop_index',
            });
            return {
                callId: '', success: true,
                output: { name: indexName, sql, message: `Index "${indexName}" dropped.`, duration_ms: r.duration_ms },
                duration_ms: Date.now() - start,
            };
        } catch (err) {
            return {
                callId: '', success: false,
                output: { name: indexName },
                error: err instanceof Error ? err.message : 'drop_index failed',
                duration_ms: Date.now() - start,
            };
        }
    },
});

// ── execute_game_sql ──────────────────────────────────────────────────

registerTool({
    name: 'execute_game_sql',
    description: 'Run arbitrary SQL against the project\'s game database. Validator blocks CREATE EXTENSION/FUNCTION/SCHEMA, transactions, COPY, GRANT, references to other schemas, etc. Use for SELECTs with joins, conditional UPDATEs, and any case the structured tools don\'t cover. SELECTs return rows; everything else returns row_count.',
    parameters: {
        type: 'object',
        properties: {
            sql: {
                type: 'string',
                description: 'A single SQL statement (or multiple separated by semicolons — each is validated). No schema prefix needed; search_path is pinned to the project schema.',
            },
            limit: {
                type: 'integer',
                default: 200,
                description: 'For queries, cap rows returned to the agent (output truncation). Does NOT add a LIMIT clause to the SQL itself.',
            },
        },
        required: ['sql'],
    },
    access: ['build'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const start = Date.now();
        const sql = (input.sql as string).trim();
        const limit = (input.limit as number) ?? 200;
        try {
            const v = validateSql(sql, ctx.projectId);
            if (!v.ok) {
                return {
                    callId: '', success: false,
                    output: { sql, validation_error: v.error },
                    error: v.error,
                    duration_ms: Date.now() - start,
                };
            }

            const results: unknown[] = [];
            for (const stmt of v.statements) {
                const r = await runStatement(stmt, {
                    projectId: ctx.projectId, userId: ctx.userId, toolName: 'execute_game_sql',
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

            return {
                callId: '', success: true,
                output: results.length === 1 ? results[0] : { statement_count: results.length, results },
                duration_ms: Date.now() - start,
            };
        } catch (err) {
            return {
                callId: '', success: false,
                output: { sql },
                error: err instanceof Error ? err.message : 'SQL execution failed',
                duration_ms: Date.now() - start,
            };
        }
    },
});
