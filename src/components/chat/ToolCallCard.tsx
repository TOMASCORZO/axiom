'use client';

import { useState } from 'react';
import {
    Terminal, FileText, Search, FolderOpen, Pencil, Eye,
    Loader2, Check, X, ChevronDown, Shield, Clock,
    Gamepad2, Image, Box, Puzzle, Wrench
} from 'lucide-react';
import type { ToolCallDisplay } from '@/types/agent';

interface ToolCallCardProps {
    toolCall: ToolCallDisplay;
    pendingPermission?: { patterns: string[] };
    onRespondPermission?: (toolName: string, granted: boolean) => void;
}

// ── Tool icon mapping ────────────────────────────────────────────
const TOOL_ICONS: Record<string, typeof Terminal> = {
    bash: Terminal,
    repl: Terminal,
    file_read: Eye,
    file_write: Pencil,
    file_edit: Pencil,
    glob: FolderOpen,
    grep: Search,
    write_game_logic: FileText,
    create_scene: Gamepad2,
    modify_scene: Gamepad2,
    modify_physics: Gamepad2,
    generate_sprite: Image,
    generate_texture: Image,
    generate_3d_model: Box,
    generate_animation: Image,
    search_free_asset: Search,
    update_ui_layout: Puzzle,
    debug_runtime_error: Wrench,
    export_build: Box,
};

function getToolIcon(name: string) {
    return TOOL_ICONS[name] ?? Wrench;
}

// ── Human-readable tool summary ──────────────────────────────────
function getToolSummary(name: string, input: Record<string, unknown>): string {
    switch (name) {
        case 'bash':
            return truncate(String(input.command ?? ''), 80);
        case 'repl':
            return `${input.language ?? 'node'}: ${truncate(String(input.code ?? ''), 60)}`;
        case 'file_read':
        case 'FileReadTool':
            return String(input.file_path ?? input.path ?? '');
        case 'file_write':
        case 'FileWriteTool':
            return String(input.file_path ?? input.path ?? '');
        case 'file_edit':
        case 'FileEditTool':
            return String(input.file_path ?? input.path ?? '');
        case 'glob':
        case 'GlobTool':
            return String(input.pattern ?? '');
        case 'grep':
        case 'GrepTool':
            return `/${input.pattern ?? ''}/ ${input.path ? 'in ' + input.path : ''}`;
        case 'write_game_logic':
            return String(input.file_path ?? '');
        case 'create_scene':
            return String(input.scene_name ?? input.target_path ?? '');
        case 'modify_scene':
            return String(input.scene_path ?? '');
        case 'generate_sprite':
        case 'generate_texture':
        case 'generate_3d_model':
            return truncate(String(input.prompt ?? ''), 60);
        case 'generate_animation':
            return truncate(String(input.prompt ?? ''), 60);
        case 'search_free_asset':
            return `"${truncate(String(input.query ?? ''), 50)}" (${input.asset_type ?? 'any'})`;
        default:
            return name;
    }
}

function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max) + '...' : s;
}

// ── Status rendering ─────────────────────────────────────────────
function StatusIndicator({ status }: { status: ToolCallDisplay['status'] }) {
    switch (status) {
        case 'pending':
            return <Loader2 size={11} className="text-zinc-500 animate-spin flex-shrink-0" />;
        case 'running':
            return <Loader2 size={11} className="text-amber-400 animate-spin flex-shrink-0" />;
        case 'completed':
            return <Check size={11} className="text-emerald-400 flex-shrink-0" />;
        case 'failed':
            return <X size={11} className="text-red-400 flex-shrink-0" />;
    }
}

// ── Main component ───────────────────────────────────────────────
export default function ToolCallCard({ toolCall, pendingPermission, onRespondPermission }: ToolCallCardProps) {
    const [expanded, setExpanded] = useState(false);
    const { name, status, error, input, output, filesModified, duration_ms } = toolCall;

    const Icon = getToolIcon(name);
    const summary = getToolSummary(name, input ?? {});
    const hasOutput = output !== undefined && output !== null;
    const hasError = !!error;

    return (
        <div className="my-1">
            {/* CC-style connector + tool header */}
            <div className="flex items-start">
                {/* Left connector line */}
                <div className="flex-shrink-0 w-4 flex flex-col items-center mr-1">
                    <span className="text-zinc-700 text-xs leading-none select-none">⎿</span>
                </div>

                {/* Tool content */}
                <div className="flex-1 min-w-0">
                    {/* Header row */}
                    <button
                        onClick={() => setExpanded(!expanded)}
                        className="w-full flex items-center gap-1.5 text-xs hover:bg-white/[0.03] rounded px-1 py-0.5 -ml-1 transition-colors group/tool"
                    >
                        <StatusIndicator status={status} />
                        <Icon size={11} className="text-zinc-500 flex-shrink-0" />
                        <span className="text-zinc-400 font-medium">{formatToolName(name)}</span>
                        {summary && summary !== name && (
                            <span className="text-zinc-600 font-mono text-[11px] truncate">
                                {summary}
                            </span>
                        )}
                        {duration_ms !== undefined && status === 'completed' && (
                            <span className="text-zinc-700 text-[10px] ml-auto flex items-center gap-0.5 flex-shrink-0">
                                <Clock size={8} />
                                {duration_ms < 1000 ? `${duration_ms}ms` : `${(duration_ms / 1000).toFixed(1)}s`}
                            </span>
                        )}
                        {filesModified && filesModified.length > 0 && (
                            <span className="text-zinc-600 text-[10px] flex-shrink-0">
                                {filesModified.length} file{filesModified.length !== 1 ? 's' : ''}
                            </span>
                        )}
                        <ChevronDown
                            size={10}
                            className={`text-zinc-700 transition-transform flex-shrink-0 opacity-0 group-hover/tool:opacity-100 ${expanded ? '' : '-rotate-90'}`}
                        />
                    </button>

                    {/* Inline result preview (CC shows brief result even when collapsed) */}
                    {!expanded && status === 'completed' && hasOutput && (
                        <ToolResultPreview name={name} output={output} />
                    )}

                    {/* Error inline (always visible) */}
                    {!expanded && hasError && (
                        <div className="ml-1 mt-0.5 text-[11px] text-red-400/80 font-mono truncate">
                            Error: {error}
                        </div>
                    )}

                    {/* Expanded details */}
                    {expanded && (
                        <div className="ml-1 mt-1 space-y-1.5 animate-in fade-in duration-100">
                            {/* Input */}
                            {input && Object.keys(input).length > 0 && (
                                <ToolInputSection name={name} input={input} />
                            )}

                            {/* Output */}
                            {hasOutput && (
                                <ToolOutputSection name={name} output={output} />
                            )}

                            {/* Error detail */}
                            {hasError && (
                                <div className="rounded bg-red-500/10 border border-red-500/20 px-2 py-1.5">
                                    <span className="text-[10px] text-red-500 font-medium uppercase">Error</span>
                                    <pre className="mt-0.5 text-[11px] text-red-400 font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
                                        {error}
                                    </pre>
                                </div>
                            )}

                            {/* Files modified */}
                            {filesModified && filesModified.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-1">
                                    {filesModified.map((f, i) => (
                                        <span key={i} className="text-[10px] text-zinc-500 bg-zinc-900/50 rounded px-1.5 py-0.5 font-mono">
                                            {f}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Permission gate */}
                    {pendingPermission && status === 'running' && (
                        <div className="mt-1.5 rounded bg-amber-500/10 border border-amber-500/20 px-2.5 py-2">
                            <div className="flex items-center gap-1.5 text-xs text-amber-300 mb-1.5">
                                <Shield size={11} />
                                <span className="font-medium">Permission required</span>
                            </div>
                            {pendingPermission.patterns?.length > 0 && (
                                <p className="text-[10px] text-amber-400/60 font-mono mb-2">
                                    {pendingPermission.patterns.join(', ')}
                                </p>
                            )}
                            <div className="flex gap-2">
                                <button
                                    onClick={(e) => { e.stopPropagation(); onRespondPermission?.(name, true); }}
                                    className="px-2.5 py-1 bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 rounded text-[11px] font-medium transition-colors border border-emerald-500/30"
                                >
                                    Allow
                                </button>
                                <button
                                    onClick={(e) => { e.stopPropagation(); onRespondPermission?.(name, false); }}
                                    className="px-2.5 py-1 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 rounded text-[11px] font-medium transition-colors border border-zinc-700"
                                >
                                    Deny
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// ── Tool name formatter ──────────────────────────────────────────
function formatToolName(name: string): string {
    const MAP: Record<string, string> = {
        bash: 'Bash',
        repl: 'REPL',
        file_read: 'Read',
        file_write: 'Write',
        file_edit: 'Edit',
        glob: 'Glob',
        grep: 'Grep',
        FileReadTool: 'Read',
        FileWriteTool: 'Write',
        FileEditTool: 'Edit',
        GlobTool: 'Glob',
        GrepTool: 'Grep',
        write_game_logic: 'Write Script',
        create_scene: 'Create Scene',
        modify_scene: 'Modify Scene',
        modify_physics: 'Physics',
        generate_sprite: 'Generate Sprite',
        generate_texture: 'Generate Texture',
        generate_3d_model: 'Generate 3D Model',
        generate_animation: 'Generate Animation',
        search_free_asset: 'Search Assets',
        update_ui_layout: 'Update UI',
        debug_runtime_error: 'Debug Error',
        export_build: 'Export Build',
    };
    return MAP[name] ?? name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Inline result preview (shown when collapsed) ─────────────────
function ToolResultPreview({ name, output }: { name: string; output: any }) {
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    if (!text || text === '{}' || text === 'null') return null;

    // For bash: show first line of output
    if (name === 'bash' || name === 'repl') {
        const firstLine = text.split('\n')[0] ?? '';
        if (!firstLine.trim()) return null;
        return (
            <div className="ml-1 mt-0.5 text-[11px] text-zinc-600 font-mono truncate max-w-full">
                {truncate(firstLine, 120)}
            </div>
        );
    }

    // For file reads: show line count
    if (name === 'file_read' || name === 'FileReadTool') {
        const lines = text.split('\n').length;
        return (
            <div className="ml-1 mt-0.5 text-[10px] text-zinc-600">
                {lines} line{lines !== 1 ? 's' : ''}
            </div>
        );
    }

    // For grep/glob: show match count
    if (name === 'grep' || name === 'glob' || name === 'GrepTool' || name === 'GlobTool') {
        const lines = text.split('\n').filter((l: string) => l.trim()).length;
        return (
            <div className="ml-1 mt-0.5 text-[10px] text-zinc-600">
                {lines} result{lines !== 1 ? 's' : ''}
            </div>
        );
    }

    return null;
}

// ── Input section (expanded) ─────────────────────────────────────
function ToolInputSection({ name, input }: { name: string; input: Record<string, unknown> }) {
    // Bash: show command as code block
    if ((name === 'bash' || name === 'repl') && input.command) {
        return (
            <div className="rounded bg-zinc-900/60 border border-zinc-800/50 px-2 py-1.5">
                <span className="text-[10px] text-zinc-600 font-medium">$</span>
                <pre className="text-[11px] text-zinc-300 font-mono whitespace-pre-wrap break-all mt-0.5 max-h-24 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800">
                    {String(input.command)}
                </pre>
            </div>
        );
    }

    // File edit: show old_string → new_string
    if ((name === 'file_edit' || name === 'FileEditTool') && input.old_string !== undefined) {
        return (
            <div className="rounded bg-zinc-900/60 border border-zinc-800/50 overflow-hidden">
                <div className="px-2 py-1 border-b border-zinc-800/50 text-[10px] text-zinc-500 font-mono">
                    {String(input.file_path ?? '')}
                </div>
                {input.old_string && (
                    <div className="px-2 py-1 bg-red-500/5 border-b border-zinc-800/30">
                        <pre className="text-[10px] text-red-400/70 font-mono whitespace-pre-wrap max-h-16 overflow-y-auto">
                            {String(input.old_string)}
                        </pre>
                    </div>
                )}
                {input.new_string !== undefined && (
                    <div className="px-2 py-1 bg-emerald-500/5">
                        <pre className="text-[10px] text-emerald-400/70 font-mono whitespace-pre-wrap max-h-16 overflow-y-auto">
                            {String(input.new_string)}
                        </pre>
                    </div>
                )}
            </div>
        );
    }

    // Default: JSON
    return (
        <div className="rounded bg-zinc-900/60 border border-zinc-800/50 px-2 py-1.5">
            <pre className="text-[10px] text-zinc-500 font-mono whitespace-pre-wrap max-h-24 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800">
                {JSON.stringify(input, null, 2)}
            </pre>
        </div>
    );
}

// ── Output section (expanded) ────────────────────────────────────
function ToolOutputSection({ name, output }: { name: string; output: any }) {
    const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);

    // Bash output: terminal-style
    if (name === 'bash' || name === 'repl') {
        return (
            <div className="rounded bg-zinc-950 border border-zinc-800/50 px-2 py-1.5">
                <pre className="text-[11px] text-zinc-400 font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800">
                    {text}
                </pre>
            </div>
        );
    }

    // File content: code-style
    if (name === 'file_read' || name === 'FileReadTool') {
        return (
            <div className="rounded bg-zinc-900/60 border border-zinc-800/50 px-2 py-1.5">
                <pre className="text-[10px] text-zinc-400 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800 leading-relaxed">
                    {text}
                </pre>
            </div>
        );
    }

    // Default
    return (
        <div className="rounded bg-zinc-900/60 border border-zinc-800/50 px-2 py-1.5">
            <span className="text-[10px] text-zinc-600 font-medium uppercase">Output</span>
            <pre className="mt-0.5 text-[10px] text-zinc-500 font-mono whitespace-pre-wrap max-h-32 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800">
                {text}
            </pre>
        </div>
    );
}
