'use client';

import { useState, useEffect, useCallback } from 'react';
import { useEditorStore } from '@/lib/store';
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

type Tab = 'tables' | 'sql' | 'audit';

const TABS: { id: Tab; label: string; icon: typeof TableIcon }[] = [
    { id: 'tables', label: 'Tables', icon: TableIcon },
    { id: 'sql', label: 'SQL Console', icon: Terminal },
    { id: 'audit', label: 'Audit', icon: History },
];

// ── Helpers ────────────────────────────────────────────────────────────

function renderCell(value: unknown): string {
    if (value === null || value === undefined) return '∅';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

// ── Tables Tab ─────────────────────────────────────────────────────────

function TablesTab() {
    const project = useEditorStore(s => s.project);
    const [tables, setTables] = useState<TableSummary[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [schema, setSchema] = useState<TableSchema | null>(null);
    const [rowsPage, setRowsPage] = useState<RowsPage | null>(null);
    const [page, setPage] = useState(1);

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

    useEffect(() => { refreshTables(); }, [refreshTables]);

    const loadTable = useCallback(async (name: string, p = 1) => {
        if (!project?.id) return;
        setSelected(name);
        setPage(p);
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
                        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Schema · {selected}</div>
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
                            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                                Rows · page {rowsPage.page} · {rowsPage.row_count} returned
                            </div>
                            {rowsPage.rows.length === 0 ? (
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
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {rowsPage.rows.map((row, i) => (
                                                <tr key={i} className="border-t border-white/5">
                                                    {schema.columns.map(c => (
                                                        <td key={c.name} className="px-2 py-1 font-mono text-zinc-300 whitespace-nowrap max-w-[160px] truncate">
                                                            {renderCell(row[c.name])}
                                                        </td>
                                                    ))}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            <div className="flex items-center gap-1 mt-2">
                                <button
                                    onClick={() => loadTable(selected, Math.max(1, page - 1))}
                                    disabled={page <= 1}
                                    className="px-2 py-0.5 text-[10px] rounded bg-zinc-900 text-zinc-400 border border-white/5 disabled:opacity-30 hover:text-zinc-200"
                                >Prev</button>
                                <span className="text-[10px] text-zinc-600">page {page}</span>
                                <button
                                    onClick={() => loadTable(selected, page + 1)}
                                    disabled={rowsPage.row_count < rowsPage.page_size}
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

function SqlConsoleTab() {
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
            addConsoleEntry({
                id: crypto.randomUUID(), level: 'log',
                message: `[Database Studio] Ran ${data.statement_count} statement(s)`,
                timestamp: new Date().toISOString(),
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Network error');
        } finally {
            setRunning(false);
        }
    };

    return (
        <div className="flex flex-col flex-1 overflow-hidden p-3 gap-2">
            <textarea
                value={sql}
                onChange={e => setSql(e.target.value)}
                onKeyDown={e => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); handleRun(); }
                }}
                rows={6}
                placeholder="SELECT * FROM your_table"
                className="w-full bg-zinc-900 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-cyan-500/50 transition-colors"
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

function AuditTab() {
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

    useEffect(() => { refresh(); }, [refresh]);

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

// ── Main Component ─────────────────────────────────────────────────────

export default function DatabaseStudio() {
    const setActiveRightPanel = useEditorStore(s => s.setActiveRightPanel);
    const [tab, setTab] = useState<Tab>('tables');

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
                <button
                    onClick={() => setActiveRightPanel('chat')}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 px-2 py-0.5 rounded hover:bg-white/5 transition-colors"
                >
                    Back to Chat
                </button>
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

            {tab === 'tables' && <TablesTab />}
            {tab === 'sql' && <SqlConsoleTab />}
            {tab === 'audit' && <AuditTab />}
        </div>
    );
}
