'use client';

import { useState } from 'react';
import { Brain, ChevronRight, Loader2 } from 'lucide-react';

interface ThinkingBlockProps {
    text: string;
    isStreaming?: boolean;
}

export default function ThinkingBlock({ text, isStreaming }: ThinkingBlockProps) {
    const [expanded, setExpanded] = useState(false);
    const lines = text.split('\n').filter(l => l.trim());
    const preview = lines[0]?.slice(0, 80) ?? 'Thinking...';

    return (
        <div className="mb-2">
            <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors w-full text-left"
            >
                {isStreaming ? (
                    <Loader2 size={10} className="text-amber-400 animate-spin flex-shrink-0" />
                ) : (
                    <Brain size={10} className="text-zinc-600 flex-shrink-0" />
                )}
                <ChevronRight size={10} className={`transition-transform flex-shrink-0 ${expanded ? 'rotate-90' : ''}`} />
                <span className="truncate italic">
                    {expanded ? 'Reasoning' : preview}
                </span>
            </button>
            {expanded && (
                <div className="mt-1.5 ml-5 pl-2.5 border-l border-zinc-800 text-[11px] text-zinc-500 leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800">
                    {text}
                </div>
            )}
        </div>
    );
}
