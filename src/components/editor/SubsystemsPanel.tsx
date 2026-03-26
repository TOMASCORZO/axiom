'use client';

import { useState, useEffect, useCallback } from 'react';
import {
    Activity,
    Plug,
    Terminal,
    Code2,
    FolderCog,
    BookOpen,
    Camera,
    Cpu,
    RefreshCw,
    Circle,
    ChevronDown,
    ChevronRight,
    Shield,
    Layers,
} from 'lucide-react';

// ── Types ───────────────────────────────────────────────────────────

interface SubsystemStatus {
    eventBus: { active: boolean; listenerCount: number };
    mcp: { servers: Array<{ name: string; status: string; toolCount: number; resourceCount: number }> };
    pty: { sessions: Array<{ id: string; command: string; status: string; exitCode: number | null }> };
    lsp: { servers: Array<{ language: string; status: string }> };
    dynamicTools: { scanPaths: string[] };
}

// ── Status Dot ──────────────────────────────────────────────────────

function StatusDot({ status }: { status: 'active' | 'inactive' | 'error' | 'running' }) {
    const colors = {
        active: 'bg-emerald-400 shadow-emerald-400/50',
        running: 'bg-amber-400 shadow-amber-400/50 animate-pulse',
        inactive: 'bg-zinc-600',
        error: 'bg-red-400 shadow-red-400/50',
    };
    return <div className={`w-1.5 h-1.5 rounded-full shadow-sm ${colors[status]}`} />;
}

// ── Subsystem Row ───────────────────────────────────────────────────

function SubsystemRow({
    icon: Icon,
    label,
    status,
    detail,
    expandable,
    children,
}: {
    icon: React.ElementType;
    label: string;
    status: 'active' | 'inactive' | 'error' | 'running';
    detail?: string;
    expandable?: boolean;
    children?: React.ReactNode;
}) {
    const [expanded, setExpanded] = useState(false);

    return (
        <div className="border-b border-white/[0.03] last:border-b-0">
            <button
                onClick={() => expandable && setExpanded(!expanded)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${
                    expandable ? 'hover:bg-white/[0.03] cursor-pointer' : 'cursor-default'
                }`}
            >
                <Icon size={12} className="text-zinc-500 flex-shrink-0" />
                <span className="text-zinc-300 font-medium flex-1 text-left">{label}</span>
                {detail && <span className="text-zinc-600 text-[10px]">{detail}</span>}
                <StatusDot status={status} />
                {expandable && (
                    expanded
                        ? <ChevronDown size={10} className="text-zinc-600" />
                        : <ChevronRight size={10} className="text-zinc-600" />
                )}
            </button>
            {expanded && children && (
                <div className="px-3 pb-2 pl-7 space-y-1">
                    {children}
                </div>
            )}
        </div>
    );
}

// ── Main Panel ──────────────────────────────────────────────────────

export default function SubsystemsPanel() {
    const [status, setStatus] = useState<SubsystemStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [collapsed, setCollapsed] = useState(false);

    const fetchStatus = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/agent/status');
            if (res.ok) {
                setStatus(await res.json());
            }
        } catch {
            // Status fetch failed
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchStatus();
        const interval = setInterval(fetchStatus, 10_000); // Poll every 10s
        return () => clearInterval(interval);
    }, [fetchStatus]);

    // ── Derived state ───────────────────────────────────────────────

    const subsystems = [
        {
            icon: Activity,
            label: 'Event Bus',
            status: (status?.eventBus.active ? 'active' : 'inactive') as 'active' | 'inactive',
            detail: status ? `${status.eventBus.listenerCount} listeners` : '...',
        },
        {
            icon: Shield,
            label: 'Approval Gate',
            status: 'active' as const,
            detail: 'fail-open',
        },
        {
            icon: Layers,
            label: 'Truncation',
            status: 'active' as const,
            detail: '50k chars',
        },
        {
            icon: Camera,
            label: 'Snapshots',
            status: 'active' as const,
            detail: 'auto-capture',
        },
    ];

    const mcpServers = status?.mcp.servers ?? [];
    const ptySessions = status?.pty.sessions ?? [];
    const lspServers = status?.lsp.servers ?? [];

    return (
        <div className="h-full flex flex-col bg-zinc-950/80 border-t border-white/5">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <button
                    onClick={() => setCollapsed(!collapsed)}
                    className="flex items-center gap-1.5 text-xs font-semibold text-zinc-400 uppercase tracking-wider hover:text-zinc-300 transition-colors"
                >
                    <Cpu size={12} className="text-violet-400" />
                    Subsystems
                    {collapsed
                        ? <ChevronRight size={10} />
                        : <ChevronDown size={10} />
                    }
                </button>
                <button
                    onClick={fetchStatus}
                    disabled={loading}
                    className="p-1 hover:bg-white/10 rounded transition-colors"
                    title="Refresh status"
                >
                    <RefreshCw size={10} className={`text-zinc-500 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            {!collapsed && (
                <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800">
                    {/* Core subsystems (always active) */}
                    {subsystems.map((s) => (
                        <SubsystemRow key={s.label} {...s} />
                    ))}

                    {/* MCP Servers */}
                    <SubsystemRow
                        icon={Plug}
                        label="MCP Servers"
                        status={mcpServers.length > 0 ? 'active' : 'inactive'}
                        detail={mcpServers.length > 0 ? `${mcpServers.length} connected` : 'none'}
                        expandable={mcpServers.length > 0}
                    >
                        {mcpServers.map((s) => (
                            <div key={s.name} className="flex items-center gap-2 text-[10px]">
                                <StatusDot status={s.status === 'ready' ? 'active' : 'error'} />
                                <span className="text-zinc-400 font-mono">{s.name}</span>
                                <span className="text-zinc-600">{s.toolCount} tools</span>
                            </div>
                        ))}
                    </SubsystemRow>

                    {/* PTY Sessions */}
                    <SubsystemRow
                        icon={Terminal}
                        label="Terminals"
                        status={ptySessions.some(s => s.status === 'running') ? 'running' : ptySessions.length > 0 ? 'active' : 'inactive'}
                        detail={ptySessions.length > 0 ? `${ptySessions.length} sessions` : 'none'}
                        expandable={ptySessions.length > 0}
                    >
                        {ptySessions.map((s) => (
                            <div key={s.id} className="flex items-center gap-2 text-[10px]">
                                <StatusDot status={s.status === 'running' ? 'running' : s.exitCode === 0 ? 'active' : 'error'} />
                                <span className="text-zinc-400 font-mono truncate max-w-[120px]">{s.command}</span>
                                <span className="text-zinc-600">{s.status}</span>
                            </div>
                        ))}
                    </SubsystemRow>

                    {/* LSP Servers */}
                    <SubsystemRow
                        icon={Code2}
                        label="LSP Servers"
                        status={lspServers.length > 0 ? 'active' : 'inactive'}
                        detail={lspServers.length > 0 ? `${lspServers.length} active` : 'none'}
                        expandable={lspServers.length > 0}
                    >
                        {lspServers.map((s) => (
                            <div key={s.language} className="flex items-center gap-2 text-[10px]">
                                <StatusDot status={s.status === 'ready' ? 'active' : s.status === 'starting' ? 'running' : 'error'} />
                                <span className="text-zinc-400">{s.language}</span>
                                <span className="text-zinc-600">{s.status}</span>
                            </div>
                        ))}
                    </SubsystemRow>

                    {/* Dynamic Tools */}
                    <SubsystemRow
                        icon={FolderCog}
                        label="Custom Tools"
                        status="active"
                        detail="scanner"
                        expandable={!!status?.dynamicTools}
                    >
                        {status?.dynamicTools.scanPaths.map((p) => (
                            <div key={p} className="text-[10px] text-zinc-600 font-mono truncate">
                                {p}
                            </div>
                        ))}
                    </SubsystemRow>

                    {/* Skills */}
                    <SubsystemRow
                        icon={BookOpen}
                        label="Skills"
                        status="active"
                        detail=".md injection"
                    />

                    {/* Compaction */}
                    <SubsystemRow
                        icon={Circle}
                        label="Compaction"
                        status="active"
                        detail="80k threshold"
                    />
                </div>
            )}
        </div>
    );
}
