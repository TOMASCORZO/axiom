/**
 * Shared SQL identifier + literal helpers for any code path that builds SQL
 * strings server-side (Studio row editor, runtime SDK endpoint, future bulk
 * importers). Keeping the regex and the escape rules in one place means a
 * fix to either propagates everywhere instead of drifting between modules.
 *
 * These do NOT replace the AST validator — they only make it harder to inject
 * SQL through identifier or value slots. Always run validateSql() over the
 * final string before executing.
 */

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

export function safeIdent(name: string): string {
    if (typeof name !== 'string' || !IDENT_RE.test(name)) {
        throw new Error(`Invalid identifier: ${JSON.stringify(name)}`);
    }
    return `"${name}"`;
}

// Convert an arbitrary JS value into a SQL literal. Strings are single-quote
// escaped; numbers and booleans go raw; null/undefined → NULL; anything else
// (objects, arrays of objects) is JSON-encoded and cast to jsonb.
export function safeLiteral(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('Non-finite number');
        return String(value);
    }
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}
