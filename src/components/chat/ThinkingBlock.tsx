'use client';

import { useState, useEffect, useRef } from 'react';
import { Sparkles, ChevronDown } from 'lucide-react';

interface ThinkingBlockProps {
    text: string;
    isStreaming?: boolean;
}

/**
 * CC-style thinking/reasoning block.
 * - While streaming: shows animated "Thinking..." with sparkle icon
 * - After done: collapsible block with left-border connector
 * - Auto-collapses when streaming finishes
 */
export default function ThinkingBlock({ text, isStreaming }: ThinkingBlockProps) {
    const [expanded, setExpanded] = useState(false);
    const wasStreaming = useRef(isStreaming);

    // Auto-collapse when streaming finishes
    useEffect(() => {
        if (wasStreaming.current && !isStreaming) {
            setExpanded(false);
        }
        wasStreaming.current = isStreaming;
    }, [isStreaming]);

    const lines = text.split('\n').filter(l => l.trim());
    const lineCount = lines.length;
    const preview = lines[0]?.slice(0, 120) ?? 'Reasoning...';

    if (isStreaming) {
        return (
            <div className="mb-1.5">
                {/* Streaming header */}
                <button
                    onClick={() => setExpanded(!expanded)}
                    className="flex items-center gap-1.5 text-xs text-amber-400/80 hover:text-amber-300 transition-colors"
                >
                    <Sparkles size={11} className="animate-pulse flex-shrink-0" />
                    <span className="font-medium">Thinking</span>
                    <ThinkingDots />
                    <ChevronDown size={10} className={`text-zinc-600 transition-transform ml-1 ${expanded ? '' : '-rotate-90'}`} />
                </button>
                {/* Streaming content — always show while thinking */}
                <div className={`mt-1 ml-3 pl-2.5 border-l-2 border-amber-500/20 text-[11px] text-zinc-500 leading-relaxed whitespace-pre-wrap font-mono ${expanded ? 'max-h-64' : 'max-h-16'} overflow-y-auto transition-all scrollbar-thin scrollbar-thumb-zinc-800`}>
                    {text}
                </div>
            </div>
        );
    }

    // Completed thinking block
    return (
        <div className="mb-1.5">
            <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors group/think"
            >
                <Sparkles size={11} className="text-zinc-600 flex-shrink-0" />
                <span className="font-medium text-zinc-500">Thought</span>
                <span className="text-zinc-700">&middot;</span>
                <span className="text-zinc-600 text-[10px]">{lineCount} line{lineCount !== 1 ? 's' : ''}</span>
                <ChevronDown size={10} className={`text-zinc-700 transition-transform ml-auto ${expanded ? '' : '-rotate-90'}`} />
            </button>
            {expanded && (
                <div className="mt-1 ml-3 pl-2.5 border-l-2 border-zinc-800 text-[11px] text-zinc-500 leading-relaxed whitespace-pre-wrap font-mono max-h-64 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800 animate-in fade-in duration-150">
                    {text}
                </div>
            )}
            {!expanded && (
                <div className="mt-0.5 ml-3 pl-2.5 border-l-2 border-zinc-800/50 text-[11px] text-zinc-600 truncate italic cursor-pointer hover:text-zinc-500" onClick={() => setExpanded(true)}>
                    {preview}
                </div>
            )}
        </div>
    );
}

function ThinkingDots() {
    return (
        <span className="inline-flex gap-[2px] ml-0.5">
            <span className="w-1 h-1 rounded-full bg-amber-400/60 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1 h-1 rounded-full bg-amber-400/60 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1 h-1 rounded-full bg-amber-400/60 animate-bounce" style={{ animationDelay: '300ms' }} />
        </span>
    );
}
