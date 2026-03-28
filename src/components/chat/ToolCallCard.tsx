'use client';

import { useState } from 'react';
import { Wrench, Loader2, Check, X, ChevronRight } from 'lucide-react';
import type { ToolCallDisplay } from '@/types/agent';

interface ToolCallCardProps {
    toolCall: ToolCallDisplay;
}

export default function ToolCallCard({ toolCall }: ToolCallCardProps) {
    const [expanded, setExpanded] = useState(false);
    const { name, status, filesModified, error, input } = toolCall;

    const statusIcon = {
        pending: <Loader2 size={12} className="text-zinc-500 animate-spin" />,
        running: <Loader2 size={12} className="text-amber-400 animate-spin" />,
        completed: <Check size={12} className="text-emerald-400" />,
        failed: <X size={12} className="text-red-400" />,
    }[status];

    const statusColor = {
        pending: 'text-zinc-500',
        running: 'text-amber-400',
        completed: 'text-emerald-400',
        failed: 'text-red-400',
    }[status];

    return (
        <div className="rounded-lg bg-black/30 border border-white/5 overflow-hidden">
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-white/5 transition-colors"
            >
                {statusIcon}
                <Wrench size={11} className="text-zinc-500 flex-shrink-0" />
                <span className="text-zinc-300 font-mono truncate">{name}</span>
                {filesModified && filesModified.length > 0 && (
                    <span className="text-zinc-600 text-[10px] truncate hidden sm:inline">
                        {filesModified.join(', ')}
                    </span>
                )}
                <span className={`ml-auto text-[10px] font-medium ${statusColor}`}>
                    {status}
                </span>
                <ChevronRight size={10} className={`text-zinc-600 transition-transform flex-shrink-0 ${expanded ? 'rotate-90' : ''}`} />
            </button>

            {expanded && (
                <div className="px-2.5 pb-2 border-t border-white/5">
                    {/* Input */}
                    {input && Object.keys(input).length > 0 && (
                        <div className="mt-1.5">
                            <span className="text-[10px] text-zinc-600 uppercase font-medium">Input</span>
                            <pre className="mt-0.5 text-[10px] text-zinc-500 leading-relaxed overflow-x-auto max-h-24 scrollbar-thin scrollbar-thumb-zinc-800">
                                {JSON.stringify(input, null, 2)}
                            </pre>
                        </div>
                    )}
                    {/* Error */}
                    {error && (
                        <div className="mt-1.5">
                            <span className="text-[10px] text-red-500 uppercase font-medium">Error</span>
                            <p className="mt-0.5 text-[10px] text-red-400">{error}</p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
