'use client';

import { Bot, User } from 'lucide-react';
import type { ChatMessage as ChatMessageType, ContentBlock } from '@/types/agent';
import ThinkingBlock from './ThinkingBlock';
import ToolCallBlock from './ToolCallCard';

interface ChatMessageProps {
    message: ChatMessageType;
    pendingPermissions?: Record<string, { patterns: string[] }>;
    onRespondPermission?: (toolName: string, granted: boolean) => void;
}

/**
 * CC-style message renderer.
 * - User messages: compact bubble
 * - Assistant messages: inline flow with ordered content blocks
 *   (thinking → text → tool calls → text → tool calls → ...)
 */
export default function ChatMessage({ message, pendingPermissions, onRespondPermission }: ChatMessageProps) {
    const isUser = message.role === 'user';

    if (isUser) {
        return (
            <div className="flex items-start gap-2 group">
                <div className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center mt-0.5 bg-violet-500/15">
                    <User size={12} className="text-violet-400" />
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-100 whitespace-pre-wrap break-words leading-relaxed">
                        {message.content}
                    </p>
                </div>
            </div>
        );
    }

    // Assistant message: render ordered content blocks (CC-style)
    const blocks = message.blocks;

    if (blocks && blocks.length > 0) {
        return (
            <div className="flex items-start gap-2 group">
                <div className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center mt-0.5 bg-emerald-500/15">
                    <Bot size={12} className="text-emerald-400" />
                </div>
                <div className="flex-1 min-w-0 space-y-0">
                    {blocks.map((block, i) => (
                        <AssistantBlock 
                            key={i} 
                            block={block} 
                            isLast={i === blocks.length - 1} 
                            isStreaming={message.isStreaming} 
                            pendingPermissions={pendingPermissions}
                            onRespondPermission={onRespondPermission}
                        />
                    ))}
                </div>
            </div>
        );
    }

    // Fallback: legacy rendering (reasoning + content + toolCalls)
    return (
        <div className="flex items-start gap-2 group">
            <div className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center mt-0.5 bg-emerald-500/15">
                <Bot size={12} className="text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0 space-y-0">
                {message.reasoning && (
                    <ThinkingBlock text={message.reasoning} isStreaming={message.isStreaming} />
                )}
                {message.content && (
                    <div className="text-sm text-zinc-200 whitespace-pre-wrap break-words leading-relaxed">
                        {renderMarkdownLite(message.content)}
                    </div>
                )}
                {message.toolCalls && message.toolCalls.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                        {message.toolCalls.map((tc) => (
                            <ToolCallBlock 
                                key={tc.id} 
                                toolCall={tc} 
                                pendingPermission={pendingPermissions?.[tc.name]}
                                onRespondPermission={onRespondPermission}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function AssistantBlock({ 
    block, isLast, isStreaming, pendingPermissions, onRespondPermission 
}: { 
    block: ContentBlock; isLast: boolean; isStreaming?: boolean;
    pendingPermissions?: Record<string, { patterns: string[] }>;
    onRespondPermission?: (toolName: string, granted: boolean) => void;
}) {
    switch (block.type) {
        case 'thinking':
            return <ThinkingBlock text={block.text} isStreaming={block.isStreaming} />;
        case 'text':
            return (
                <div className="text-sm text-zinc-200 whitespace-pre-wrap break-words leading-relaxed">
                    {renderMarkdownLite(block.text)}
                    {isLast && isStreaming && <StreamingCursor />}
                </div>
            );
        case 'tool_use':
            return <ToolCallBlock 
                toolCall={block.toolCall} 
                pendingPermission={pendingPermissions?.[block.toolCall.name]}
                onRespondPermission={onRespondPermission}
            />;
        default:
            return null;
    }
}

function StreamingCursor() {
    return (
        <span className="inline-block w-1.5 h-4 bg-emerald-400/80 rounded-sm animate-pulse ml-0.5 align-text-bottom" />
    );
}

/** Lightweight markdown: bold, italic, code, inline code, links */
function renderMarkdownLite(text: string): React.ReactNode {
    if (!text) return null;

    const parts: React.ReactNode[] = [];
    // Split by code blocks first
    const segments = text.split(/(```[\s\S]*?```|`[^`]+`)/g);

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.startsWith('```') && seg.endsWith('```')) {
            // Fenced code block
            const inner = seg.slice(3, -3);
            const newlineIdx = inner.indexOf('\n');
            const lang = newlineIdx > 0 ? inner.slice(0, newlineIdx).trim() : '';
            const code = newlineIdx > 0 ? inner.slice(newlineIdx + 1) : inner;
            parts.push(
                <pre key={i} className="my-1.5 p-2.5 bg-zinc-900/80 border border-zinc-800/50 rounded-md text-xs overflow-x-auto">
                    {lang && <div className="text-[10px] text-zinc-600 mb-1 font-mono">{lang}</div>}
                    <code className="text-emerald-300/90 font-mono">{code}</code>
                </pre>
            );
        } else if (seg.startsWith('`') && seg.endsWith('`')) {
            // Inline code
            parts.push(
                <code key={i} className="px-1 py-0.5 bg-zinc-800/60 rounded text-xs text-emerald-300/80 font-mono">
                    {seg.slice(1, -1)}
                </code>
            );
        } else {
            // Regular text — handle bold, italic
            const formatted = seg
                .split(/(\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g)
                .map((part, j) => {
                    if (part.startsWith('**') && part.endsWith('**')) {
                        return <strong key={j} className="text-zinc-100 font-semibold">{part.slice(2, -2)}</strong>;
                    }
                    if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) {
                        return <em key={j} className="text-zinc-400 italic">{part.slice(1, -1)}</em>;
                    }
                    return part;
                });
            parts.push(<span key={i}>{formatted}</span>);
        }
    }

    return <>{parts}</>;
}
