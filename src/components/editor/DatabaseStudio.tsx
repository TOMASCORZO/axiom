'use client';

import { useState, useEffect, useCallback } from 'react';
import { useEditorStore } from '@/lib/store';
import { SqlEditor } from './SqlHighlighter';
import {
    Database,
    Table as TableIcon,
    Terminal,
    History,
    RefreshCw,
    Loader2,
    Play,
    AlertTriangle,
    CheckCircle2,
    XCircle,
    Pencil,
    Trash2,
    Plus,
    Check,
    X,
    Flame,
    GitBranch,
    Download,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────

interface TableSummary {
    name: string;
    row_count: number;
}

interface Column {
    name: string;
    type: string;
    nullable: boolean;
    default: string | null;
}

interface TableSchema {
    table_name: string;
    columns: Column[];
    primary_key: string[];
}

interface RowsPage {
    rows: Record<string, unknown>[];
    page: number;
    page_size: number;
    row_count: number;
}

type ExecResult =
    | { kind: 'query'; rows: Record<string, unknown>[]; truncated: boolean; row_count: number; duration_ms: number }
    | { kind: 'exec' | 'ddl'; row_count: number; duration_ms: number };

interface AuditEntry {
    id: string;
    tool_name: string | null;
    statement: string;
    kind: 'query' | 'exec' | 'ddl' | 'error';
    success: boolean;
    row_count: number | null;
    duration_ms: number | null;
    error: string | null;
    executed_at: string;
}

interface MigrationEntry {
    version: number;
    sql_up: string;
    description: string | null;
    applied_by: string | null;
    applied_at: string;
}

type Tab = 'tables' | 'sql' | 'migrations' | 'audit';

const TABS: { id: Tab; label: string; icon: typeof TableIcon }[] = [
    { id: 'tables', label: 'Tables', icon: TableIcon },
    { id: 'sql', label: 'SQL Console', icon: Terminal },
    { id: 'migrations', label: 'Migrations', icon: GitBranch },
    { id: 'audit', label: 'Audit', icon: History },
];

// ── Helpers ────────────────────────────────────────────────────────────

function renderCell(value: unknown): string {
    if (value === null || value === undefined) return '∅';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

// Best-effort string→typed conversion for the inline row editor. Empty string
// maps to NULL so users can clear a nullable column; anything that parses as
// JSON (numbers, booleans, objects, arrays) is sent typed; everything else
// goes as a plain string and lets Postgres do the cast.
function parseEditValue(input: string): unknown {
    if (input === '') return null;
    try {
        const parsed = JSON.parse(input);
        // JSON.parse('"hello"') returns "hello" — we want that. JSON.parse('foo')
        // throws and falls through to the string branch below.
        return parsed;
    } catch {
        return input;
    }
}

// Inverse of parseEditValue for prefilling the input. Strings are shown raw
// (no surrounding quotes); null shows as empty; everything else is JSON.
function stringifyForEdit(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
}

// ── Tables Tab ─────────────────────────────────────────────────────────

type EditRow =
    | { mode: 'edit'; index: number; pk: Record<string, unknown>; draft: Record<string, string> }
    | { mode: 'insert'; draft: Record<string, string> };

function TablesTab({ refreshKey }: { refreshKey: number }) {
    const project = useEditorStore(s => s.project);
    const [tables, setTables] = useState<TableSummary[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [schema, setSchema] = useState<TableSchema | null>(null);
    const [rowsPage, setRowsPage] = useState<RowsPage | null>(null);
    const [page, setPage] = useState(1);
    const [editing, setEditing] = useState<EditRow | null>(null);
    const [rowError, setRowError] = useState<string | null>(null);
    const [rowBusy, setRowBusy] = useState(false);

    const refreshTables = useCallback(async () => {
        if (!project?.id) return;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/database/tables?project_id=${project.id}`);
            const data = await res.json();
            if (!res.ok) {
                setError(data.error ?? 'Failed to list tables');
                return;
            }
            setTables(data.tables ?? []);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Network error');
        } finally {
            setLoading(false);
        }
    }, [project?.id]);

    useEffect(() => {
        refreshTables();
        // Drop selection when the parent forces a reload (e.g. after Reset).
        if (refreshKey > 0) {
            setSelected(null);
            setSchema(null);
            setRowsPage(null);
            setEditing(null);
        }
    }, [refreshTables, refreshKey]);

    const loadTable = useCallback(async (name: string, p = 1) => {
        if (!project?.id) return;
        setSelected(name);
        setPage(p);
        setEditing(null);
        setRowError(null);
        try {
            const [schemaRes, rowsRes] = await Promise.all([
                fetch(`/api/database/tables/${encodeURIComponent(name)}?project_id=${project.id}`),
                fetch(`/api/database/tables/${encodeURIComponent(name)}/rows?project_id=${project.id}&page=${p}&page_size=50`),
            ]);
            const [schemaData, rowsData] = await Promise.all([schemaRes.json(), rowsRes.json()]);
            if (!schemaRes.ok) { setError(schemaData.error ?? 'Failed to describe table'); return; }
            if (!rowsRes.ok) { setError(rowsData.error ?? 'Failed to load rows'); return; }
            setSchema(schemaData);
            setRowsPage(rowsData);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Network error');
        }
    }, [project?.id]);

    const beginEdit = (row: Record<string, unknown>, index: number) => {
        if (!schema) return;
        const pk: Record<string, unknown> = {};
        for (const k of schema.primary_key) pk[k] = row[k];
        const draft: Record<string, string> = {};
        for (const c of schema.columns) draft[c.name] = stringifyForEdit(row[c.name]);
        setEditing({ mode: 'edit', index, pk, draft });
        setRowError(null);
    };

    const beginInsert = () => {
        if (!schema) return;
        const draft: Record<string, string> = {};
        for (const c of schema.columns) draft[c.name] = '';
        setEditing({ mode: 'insert', draft });
        setRowError(null);
    };

    const cancelEdit = () => { setEditing(null); setRowError(null); };

    const updateDraftField = (col: string, value: string) => {
        setEditing(curr => curr ? ({ ...curr, draft: { ...curr.draft, [col]: value } }) : curr);
    };

    const saveEdit = async () => {
        if (!editing || !schema || !selected || !project?.id) return;
        setRowBusy(true);
        setRowError(null);
        try {
            if (editing.mode === 'insert') {
                // Send only fields the user actually filled in. Empty string is
                // treated as "skip and let the column default apply" — explicit
                // NULL is what the edit-mode flow handles, but for inserts the
                // user almost always wants the default to fire.
                const values: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(editing.draft)) {
                    if (v !== '') values[k] = parseEditValue(v);
                }
                const res = await fetch(`/api/database/tables/${encodeURIComponent(selected)}/rows`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ project_id: project.id, values }),
                });
                const data = await res.json();
                if (!res.ok) { setRowError(data.error ?? 'Insert failed'); return; }
            } else {
                // Update mode: build a SET that excludes PK columns (the WHERE
                // pins them) and any field that didn't actually change.
                const original = rowsPage?.rows[editing.index] ?? {};
                const set: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(editing.draft)) {
                    if (schema.primary_key.includes(k)) continue;
                    const next = parseEditValue(v);
                    if (JSON.stringify(next) !== JSON.stringify(original[k])) set[k] = next;
                }
                if (Object.keys(set).length === 0) { setEditing(null); return; }
                const res = await fetch(`/api/database/tables/${encodeURIComponent(selected)}/rows`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ project_id: project.id, pk: editing.pk, set }),
                });
                const data = await res.json();
                if (!res.ok) { setRowError(data.error ?? 'Update failed'); return; }
            }
            setEditing(null);
            await loadTable(selected, page);
            await refreshTables();
        } catch (e) {
            setRowError(e instanceof Error ? e.message : 'Network error');
        } finally {
            setRowBusy(false);
        }
    };

    const deleteRow = async (row: Record<string, unknown>) => {
        if (!schema || !selected || !project?.id) return;
        const pk: Record<string, unknown> = {};
        for (const k of schema.primary_key) pk[k] = row[k];
        const summary = schema.primary_key.map(k => `${k}=${renderCell(pk[k])}`).join(', ');
        if (!confirm(`Delete row where ${summary}?`)) return;
        setRowBusy(true);
        setRowError(null);
        try {
            const res = await fetch(`/api/database/tables/${encodeURIComponent(selected)}/rows`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ project_id: project.id, pk }),
            });
            const data = await res.json();
            if (!res.ok) { setRowError(data.error ?? 'Delete failed'); return; }
            await loadTable(selected, page);
            await refreshTables();
        } catch (e) {
            setRowError(e instanceof Error ? e.message : 'Network error');
        } finally {
            setRowBusy(false);
        }
    };

    if (loading && !tables) {
        return (
            <div className="flex-1 flex items-center justify-center text-zinc-600">
                <Loader2 size={20} className="animate-spin" />
            </div>
        );
    }

    if (error && !tables) {
        return (
            <div className="flex-1 p-6 flex flex-col items-center gap-3 text-zinc-600">
                <AlertTriangle size={24} className="text-amber-500" />
                <p className="text-xs text-center text-amber-300">{error}</p>
                <button onClick={refreshTables} className="px-3 py-1 text-xs rounded bg-zinc-900 text-zinc-300 hover:bg-zinc-800 border border-white/10">Retry</button>
            </div>
        );
    }

    if (!tables || tables.length === 0) {
        return (
            <div className="flex-1 p-6 flex flex-col items-center gap-3 text-zinc-600">
                <Database size={32} strokeWidth={1} />
                <p className="text-sm text-center">No tables yet</p>
                <p className="text-[11px] text-center text-zinc-700 leading-relaxed">
                    Ask the agent to create a table, or use the SQL Console.<br />
                    e.g. <span className="text-zinc-500">&quot;create a players table with id, name and score&quot;</span>
                </p>
                <button
                    onClick={refreshTables}
                    className="mt-2 flex items-center gap-1.5 px-3 py-1 text-xs rounded bg-zinc-900 text-zinc-300 hover:bg-zinc-800 border border-white/10"
                >
                    <RefreshCw size={11} /> Refresh
                </button>
            </div>
        );
    }

    return (
        <div className="flex flex-col flex-1 overflow-hidden">
            {/* Tables list */}
            <div className="flex-shrink-0 border-b border-white/5 max-h-[180px] overflow-y-auto">
                <div className="flex items-center justify-between px-3 py-1.5 sticky top-0 bg-zinc-950 border-b border-white/5">
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500">Tables · {tables.length}</span>
                    <button
                        onClick={refreshTables}
                        className="p-0.5 text-zinc-500 hover:text-zinc-300 transition-colors"
                        title="Refresh"
                    >
                        <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
                    </button>
                </div>
                {tables.map(t => (
                    <button
                        key={t.name}
                        onClick={() => loadTable(t.name, 1)}
                        className={`w-full flex items-center justify-between px-3 py-1.5 text-left transition-colors ${
                            selected === t.name ? 'bg-cyan-500/10 text-cyan-300' : 'text-zinc-300 hover:bg-white/5'
                        }`}
                    >
                        <span className="text-xs font-mono truncate">{t.name}</span>
                        <span className="text-[10px] text-zinc-600 font-mono">{t.row_count} rows</span>
                    </button>
                ))}
            </div>

            {/* Selected table detail */}
            {selected && schema && (
                <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
                    <div>
                        <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] uppercase tracking-wider text-zinc-500">Schema · {selected}</span>
                            <a
                                href={project?.id ? `/api/database/export?project_id=${project.id}&format=csv&table=${encodeURIComponent(selected)}` : undefined}
                                className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 px-2 py-0.5 rounded hover:bg-white/5 transition-colors"
                                title="Download this table as CSV"
                            >
                                <Download size={10} /> CSV
                            </a>
                        </div>
                        <div className="border border-white/5 rounded overflow-hidden">
                            <table className="w-full text-[11px]">
                                <thead className="bg-zinc-900/60 text-zinc-500">
                                    <tr>
                                        <th className="text-left px-2 py-1 font-normal">Column</th>
                                        <th className="text-left px-2 py-1 font-normal">Type</th>
                                        <th className="text-left px-2 py-1 font-normal">Null</th>
                                        <th className="text-left px-2 py-1 font-normal">Default</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {schema.columns.map(c => {
                                        const isPk = schema.primary_key.includes(c.name);
                                        return (
                                            <tr key={c.name} className="border-t border-white/5">
                                                <td className="px-2 py-1 font-mono text-zinc-200">
                                                    {c.name}{isPk && <span className="ml-1 text-amber-400 text-[9px]">PK</span>}
                                                </td>
                                                <td className="px-2 py-1 font-mono text-cyan-400">{c.type}</td>
                                                <td className="px-2 py-1 text-zinc-500">{c.nullable ? 'yes' : 'no'}</td>
                                                <td className="px-2 py-1 font-mono text-zinc-600 truncate max-w-[80px]">{c.default ?? '—'}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {rowsPage && (
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                                    Rows · page {rowsPage.page} · {rowsPage.row_count} returned
                                </span>
                                <button
                                    onClick={beginInsert}
                                    disabled={editing !== null || rowBusy}
                                    className="flex items-center gap-1 px-2 py-0.5 text-[10px] rounded bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-30 transition-colors"
                                >
                                    <Plus size={10} /> New row
                                </button>
                            </div>

                            {rowError && (
                                <div className="mb-2 px-2 py-1 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] font-mono break-all">
                                    {rowError}
                                </div>
                            )}

                            {rowsPage.rows.length === 0 && editing?.mode !== 'insert' ? (
                                <div className="text-xs text-zinc-600 px-2 py-3 text-center border border-dashed border-white/5 rounded">
                                    No rows
                                </div>
                            ) : (
                                <div className="border border-white/5 rounded overflow-auto max-h-[300px]">
                                    <table className="w-full text-[11px]">
                                        <thead className="bg-zinc-900/60 text-zinc-500 sticky top-0">
                                            <tr>
                                                {schema.columns.map(c => (
                                                    <th key={c.name} className="text-left px-2 py-1 font-normal whitespace-nowrap">{c.name}</th>
                                                ))}
                                                <th className="w-[60px] px-2 py-1"></th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {editing?.mode === 'insert' && (
                                                <tr className="border-t border-cyan-500/20 bg-cyan-500/5">
                                                    {schema.columns.map(c => (
                                                        <td key={c.name} className="px-1 py-1">
                                                            <input
                                                                value={editing.draft[c.name] ?? ''}
                                                                onChange={e => updateDraftField(c.name, e.target.value)}
                                                                placeholder={c.default ? `default: ${c.default}` : (c.nullable ? 'NULL' : '')}
                                                                className="w-full bg-zinc-950 border border-white/10 rounded px-1.5 py-0.5 text-[11px] font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-cyan-500/50"
                                                            />
                                                        </td>
                                                    ))}
                                                    <td className="px-1 py-1 whitespace-nowrap">
                                                        <button onClick={saveEdit} disabled={rowBusy} className="p-1 text-emerald-400 hover:bg-emerald-500/10 rounded disabled:opacity-30" title="Save">
                                                            {rowBusy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                                                        </button>
                                                        <button onClick={cancelEdit} disabled={rowBusy} className="p-1 text-zinc-500 hover:bg-white/5 rounded" title="Cancel">
                                                            <X size={11} />
                                                        </button>
                                                    </td>
                                                </tr>
                                            )}
                                            {rowsPage.rows.map((row, i) => {
                                                const isEditing = editing?.mode === 'edit' && editing.index === i;
                                                return (
                                                    <tr key={i} className={`group border-t border-white/5 ${isEditing ? 'bg-amber-500/5' : 'hover:bg-white/[0.02]'}`}>
                                                        {schema.columns.map(c => {
                                                            const isPk = schema.primary_key.includes(c.name);
                                                            if (isEditing) {
                                                                return (
                                                                    <td key={c.name} className="px-1 py-1">
                                                                        <input
                                                                            value={editing.draft[c.name] ?? ''}
                                                                            onChange={e => updateDraftField(c.name, e.target.value)}
                                                                            disabled={isPk}
                                                                            title={isPk ? 'Primary key (read-only)' : ''}
                                                                            className={`w-full bg-zinc-950 border border-white/10 rounded px-1.5 py-0.5 text-[11px] font-mono text-zinc-200 focus:outline-none focus:border-amber-500/50 ${isPk ? 'opacity-50 cursor-not-allowed' : ''}`}
                                                                        />
                                                                    </td>
                                                                );
                                                            }
                                                            return (
                                                                <td key={c.name} className="px-2 py-1 font-mono text-zinc-300 whitespace-nowrap max-w-[160px] truncate">
                                                                    {renderCell(row[c.name])}
                                                                </td>
                                                            );
                                                        })}
                                                        <td className="px-1 py-1 whitespace-nowrap">
                                                            {isEditing ? (
                                                                <>
                                                                    <button onClick={saveEdit} disabled={rowBusy} className="p-1 text-emerald-400 hover:bg-emerald-500/10 rounded disabled:opacity-30" title="Save">
                                                                        {rowBusy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                                                                    </button>
                                                                    <button onClick={cancelEdit} disabled={rowBusy} className="p-1 text-zinc-500 hover:bg-white/5 rounded" title="Cancel">
                                                                        <X size={11} />
                                                                    </button>
                                                                </>
                                                            ) : (
                                                                <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                                                                    <button
                                                                        onClick={() => beginEdit(row, i)}
                                                                        disabled={editing !== null || rowBusy || schema.primary_key.length === 0}
                                                                        className="p-1 text-zinc-500 hover:text-amber-400 hover:bg-amber-500/10 rounded disabled:opacity-30"
                                                                        title={schema.primary_key.length === 0 ? 'Table has no primary key — cannot edit' : 'Edit row'}
                                                                    >
                                                                        <Pencil size={11} />
                                                                    </button>
                                                                    <button
                                                                        onClick={() => deleteRow(row)}
                                                                        disabled={editing !== null || rowBusy || schema.primary_key.length === 0}
                                                                        className="p-1 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded disabled:opacity-30"
                                                                        title={schema.primary_key.length === 0 ? 'Table has no primary key — cannot delete' : 'Delete row'}
                                                                    >
                                                                        <Trash2 size={11} />
                                                                    </button>
                                                                </div>
                                                            )}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            <div className="flex items-center gap-1 mt-2">
                                <button
                                    onClick={() => loadTable(selected, Math.max(1, page - 1))}
                                    disabled={page <= 1 || editing !== null}
                                    className="px-2 py-0.5 text-[10px] rounded bg-zinc-900 text-zinc-400 border border-white/5 disabled:opacity-30 hover:text-zinc-200"
                                >Prev</button>
                                <span className="text-[10px] text-zinc-600">page {page}</span>
                                <button
                                    onClick={() => loadTable(selected, page + 1)}
                                    disabled={rowsPage.row_count < rowsPage.page_size || editing !== null}
                                    className="px-2 py-0.5 text-[10px] rounded bg-zinc-900 text-zinc-400 border border-white/5 disabled:opacity-30 hover:text-zinc-200"
                                >Next</button>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ── SQL Console Tab ────────────────────────────────────────────────────

function SqlConsoleTab({ onAfterRun }: { onAfterRun: () => void }) {
    const project = useEditorStore(s => s.project);
    const addConsoleEntry = useEditorStore(s => s.addConsoleEntry);
    const [sql, setSql] = useState('SELECT * FROM ');
    const [running, setRunning] = useState(false);
    const [results, setResults] = useState<ExecResult[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const handleRun = async () => {
        if (!project?.id || !sql.trim()) return;
        setRunning(true);
        setError(null);
        setResults(null);
        try {
            const res = await fetch('/api/database/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ project_id: project.id, sql, limit: 200 }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.validation_error ?? data.error ?? 'Execution failed');
                addConsoleEntry({
                    id: crypto.randomUUID(), level: 'error',
                    message: `[Database Studio] ${data.validation_error ?? data.error}`,
                    timestamp: new Date().toISOString(),
                });
                return;
            }
            setResults(data.results ?? []);
            const versionTag = data.migration_version ? ` · saved as v${data.migration_version}` : '';
            addConsoleEntry({
                id: crypto.randomUUID(), level: 'log',
                message: `[Database Studio] Ran ${data.statement_count} statement(s)${versionTag}`,
                timestamp: new Date().toISOString(),
            });
            onAfterRun();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Network error');
        } finally {
            setRunning(false);
        }
    };

    return (
        <div className="flex flex-col flex-1 overflow-hidden p-3 gap-2">
            <SqlEditor
                value={sql}
                onChange={setSql}
                onRun={handleRun}
                rows={6}
                placeholder="SELECT * FROM your_table"
            />
            <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-600">⌘/Ctrl+Enter to run · semicolons split statements</span>
                <button
                    onClick={handleRun}
                    disabled={running || !sql.trim()}
                    className="flex items-center gap-1.5 px-3 py-1 rounded bg-cyan-500/20 text-cyan-300 text-xs hover:bg-cyan-500/30 disabled:opacity-30 transition-colors"
                >
                    {running ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                    Run
                </button>
            </div>

            {error && (
                <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-start gap-2">
                    <XCircle size={12} className="flex-shrink-0 mt-0.5" />
                    <span className="font-mono leading-relaxed">{error}</span>
                </div>
            )}

            {results && (
                <div className="flex-1 overflow-y-auto flex flex-col gap-2">
                    {results.map((r, i) => (
                        <div key={i} className="border border-white/5 rounded">
                            <div className="px-2 py-1 bg-zinc-900/60 flex items-center justify-between text-[10px] text-zinc-500">
                                <span className="uppercase tracking-wider">{r.kind}</span>
                                <span>{r.row_count} rows · {r.duration_ms}ms</span>
                            </div>
                            {r.kind === 'query' && r.rows.length > 0 && (
                                <div className="overflow-auto max-h-[260px]">
                                    <table className="w-full text-[11px]">
                                        <thead className="bg-zinc-900/60 text-zinc-500 sticky top-0">
                                            <tr>
                                                {Object.keys(r.rows[0]).map(k => (
                                                    <th key={k} className="text-left px-2 py-1 font-normal whitespace-nowrap">{k}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {r.rows.map((row, ri) => (
                                                <tr key={ri} className="border-t border-white/5">
                                                    {Object.keys(r.rows[0]).map(k => (
                                                        <td key={k} className="px-2 py-1 font-mono text-zinc-300 whitespace-nowrap max-w-[180px] truncate">
                                                            {renderCell(row[k])}
                                                        </td>
                                                    ))}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                    {r.truncated && (
                                        <div className="text-[10px] text-amber-400 px-2 py-1 border-t border-white/5">
                                            Output truncated to 200 rows.
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Audit Tab ──────────────────────────────────────────────────────────

function AuditTab({ refreshKey }: { refreshKey: number }) {
    const project = useEditorStore(s => s.project);
    const [entries, setEntries] = useState<AuditEntry[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        if (!project?.id) return;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/database/audit?project_id=${project.id}&limit=100`);
            const data = await res.json();
            if (!res.ok) { setError(data.error ?? 'Failed to load audit'); return; }
            setEntries(data.entries ?? []);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Network error');
        } finally {
            setLoading(false);
        }
    }, [project?.id]);

    useEffect(() => { refresh(); }, [refresh, refreshKey]);

    if (loading && !entries) {
        return <div className="flex-1 flex items-center justify-center text-zinc-600"><Loader2 size={20} className="animate-spin" /></div>;
    }

    return (
        <div className="flex flex-col flex-1 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500">Recent statements</span>
                <button onClick={refresh} className="p-0.5 text-zinc-500 hover:text-zinc-300" title="Refresh">
                    <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
                </button>
            </div>
            {error && <div className="m-3 px-3 py-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-xs">{error}</div>}
            <div className="flex-1 overflow-y-auto">
                {entries && entries.length === 0 && (
                    <div className="px-3 py-6 text-xs text-center text-zinc-600">No statements yet</div>
                )}
                {entries?.map(e => (
                    <div key={e.id} className="px-3 py-2 border-b border-white/5">
                        <div className="flex items-center gap-2 mb-1">
                            {e.success
                                ? <CheckCircle2 size={11} className="text-emerald-400" />
                                : <XCircle size={11} className="text-red-400" />}
                            <span className={`text-[9px] uppercase px-1 rounded ${
                                e.kind === 'query' ? 'bg-cyan-500/10 text-cyan-300'
                                : e.kind === 'ddl' ? 'bg-amber-500/10 text-amber-300'
                                : e.kind === 'error' ? 'bg-red-500/10 text-red-300'
                                : 'bg-fuchsia-500/10 text-fuchsia-300'
                            }`}>{e.kind}</span>
                            <span className="text-[10px] text-zinc-600 font-mono">{e.tool_name ?? '?'}</span>
                            <span className="ml-auto text-[10px] text-zinc-700 font-mono">
                                {e.duration_ms ?? 0}ms
                                {e.row_count !== null && ` · ${e.row_count}r`}
                            </span>
                        </div>
                        <div className="text-[11px] font-mono text-zinc-400 leading-relaxed whitespace-pre-wrap break-all">
                            {e.statement.length > 200 ? e.statement.slice(0, 200) + '…' : e.statement}
                        </div>
                        {e.error && (
                            <div className="mt-1 text-[10px] text-red-400 font-mono break-all">{e.error}</div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

// ── Migrations Tab ─────────────────────────────────────────────────────

function MigrationsTab({ refreshKey }: { refreshKey: number }) {
    const project = useEditorStore(s => s.project);
    const [entries, setEntries] = useState<MigrationEntry[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<number | null>(null);

    const refresh = useCallback(async () => {
        if (!project?.id) return;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/database/migrations?project_id=${project.id}`);
            const data = await res.json();
            if (!res.ok) { setError(data.error ?? 'Failed to load migrations'); return; }
            setEntries(data.migrations ?? []);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Network error');
        } finally {
            setLoading(false);
        }
    }, [project?.id]);

    useEffect(() => { refresh(); }, [refresh, refreshKey]);

    const downloadAll = () => {
        if (!entries || entries.length === 0) return;
        // Replay order is oldest → newest, so reverse the newest-first list.
        const ordered = [...entries].reverse();
        const text = ordered
            .map(m => `-- v${m.version} · ${m.applied_at}${m.description ? ` · ${m.description}` : ''}\n${m.sql_up}`)
            .join('\n\n');
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `axiom-migrations-${project?.id ?? 'project'}.sql`;
        a.click();
        URL.revokeObjectURL(url);
    };

    if (loading && !entries) {
        return <div className="flex-1 flex items-center justify-center text-zinc-600"><Loader2 size={20} className="animate-spin" /></div>;
    }

    return (
        <div className="flex flex-col flex-1 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                    Schema versions · {entries?.length ?? 0}
                </span>
                <div className="flex items-center gap-1">
                    <button
                        onClick={downloadAll}
                        disabled={!entries || entries.length === 0}
                        className="text-[10px] text-zinc-500 hover:text-zinc-300 px-2 py-0.5 rounded hover:bg-white/5 disabled:opacity-30 transition-colors"
                        title="Download all migrations as a replayable .sql file"
                    >
                        Export .sql
                    </button>
                    <button onClick={refresh} className="p-0.5 text-zinc-500 hover:text-zinc-300" title="Refresh">
                        <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
                    </button>
                </div>
            </div>
            {error && <div className="m-3 px-3 py-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-xs">{error}</div>}
            <div className="flex-1 overflow-y-auto">
                {entries && entries.length === 0 && (
                    <div className="px-3 py-6 text-xs text-center text-zinc-600">
                        No migrations yet. DDL run from the SQL Console will appear here.
                    </div>
                )}
                {entries?.map(m => {
                    const open = expanded === m.version;
                    return (
                        <div key={m.version} className="border-b border-white/5">
                            <button
                                onClick={() => setExpanded(open ? null : m.version)}
                                className="w-full px-3 py-2 flex items-center justify-between hover:bg-white/[0.02] text-left"
                            >
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-[10px] uppercase px-1.5 rounded bg-amber-500/10 text-amber-300 font-mono">v{m.version}</span>
                                    <span className="text-[11px] text-zinc-400 font-mono truncate">
                                        {m.sql_up.replace(/\s+/g, ' ').slice(0, 80)}
                                    </span>
                                </div>
                                <span className="text-[10px] text-zinc-700 font-mono ml-2 flex-shrink-0">
                                    {new Date(m.applied_at).toLocaleString()}
                                </span>
                            </button>
                            {open && (
                                <pre className="px-3 pb-3 text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-all bg-zinc-950">
                                    {m.sql_up}
                                </pre>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ── Main Component ─────────────────────────────────────────────────────

export default function DatabaseStudio() {
    const setActiveRightPanel = useEditorStore(s => s.setActiveRightPanel);
    const project = useEditorStore(s => s.project);
    const addConsoleEntry = useEditorStore(s => s.addConsoleEntry);
    const [tab, setTab] = useState<Tab>('tables');
    const [resetting, setResetting] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);

    const resetDatabase = async () => {
        if (!project?.id) return;
        // Two-step confirmation: type the project id. Catastrophic + irreversible.
        const typed = prompt(
            `This will DROP every table and row in this project's database, including migration history. ` +
            `Type the project id to confirm:\n\n${project.id}`,
        );
        if (typed !== project.id) {
            if (typed !== null) alert('Project id did not match. Reset cancelled.');
            return;
        }
        setResetting(true);
        try {
            const res = await fetch('/api/database/reset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ project_id: project.id, confirm: project.id }),
            });
            const data = await res.json();
            if (!res.ok) {
                addConsoleEntry({
                    id: crypto.randomUUID(), level: 'error',
                    message: `[Database Studio] Reset failed: ${data.error}`,
                    timestamp: new Date().toISOString(),
                });
                alert(`Reset failed: ${data.error}`);
                return;
            }
            addConsoleEntry({
                id: crypto.randomUUID(), level: 'log',
                message: `[Database Studio] Database reset (${data.schema}).`,
                timestamp: new Date().toISOString(),
            });
            setRefreshKey(k => k + 1);
        } catch (e) {
            alert(`Reset failed: ${e instanceof Error ? e.message : 'Network error'}`);
        } finally {
            setResetting(false);
        }
    };

    return (
        <div className="flex flex-col h-full bg-zinc-950">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center">
                        <Database size={10} className="text-white" />
                    </div>
                    <span className="text-sm font-semibold text-zinc-200">Database Studio</span>
                </div>
                <div className="flex items-center gap-1">
                    <a
                        href={project?.id ? `/api/database/export?project_id=${project.id}&format=sql` : undefined}
                        className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded transition-colors ${
                            project?.id
                                ? 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
                                : 'text-zinc-700 cursor-not-allowed'
                        }`}
                        title="Download full schema + data as a replayable .sql file"
                    >
                        <Download size={10} />
                        Export .sql
                    </a>
                    <button
                        onClick={resetDatabase}
                        disabled={resetting || !project?.id}
                        className="flex items-center gap-1 text-[10px] text-red-400/70 hover:text-red-300 px-2 py-0.5 rounded hover:bg-red-500/10 disabled:opacity-30 transition-colors"
                        title="Drop all tables and reset the database"
                    >
                        {resetting ? <Loader2 size={10} className="animate-spin" /> : <Flame size={10} />}
                        Reset
                    </button>
                    <button
                        onClick={() => setActiveRightPanel('chat')}
                        className="text-[10px] text-zinc-500 hover:text-zinc-300 px-2 py-0.5 rounded hover:bg-white/5 transition-colors"
                    >
                        Back to Chat
                    </button>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-white/5">
                {TABS.map(t => {
                    const Icon = t.icon;
                    return (
                        <button
                            key={t.id}
                            onClick={() => setTab(t.id)}
                            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs transition-colors ${
                                tab === t.id ? 'text-cyan-400 border-b-2 border-cyan-500 bg-cyan-500/5' : 'text-zinc-500 hover:text-zinc-300'
                            }`}
                        >
                            <Icon size={12} />
                            {t.label}
                        </button>
                    );
                })}
            </div>

            {tab === 'tables' && <TablesTab refreshKey={refreshKey} />}
            {tab === 'sql' && <SqlConsoleTab onAfterRun={() => setRefreshKey(k => k + 1)} />}
            {tab === 'migrations' && <MigrationsTab refreshKey={refreshKey} />}
            {tab === 'audit' && <AuditTab refreshKey={refreshKey} />}
        </div>
    );
}
