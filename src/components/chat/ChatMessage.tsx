'use client';

import { Bot, User } from 'lucide-react';
import type { ChatMessage as ChatMessageType } from '@/types/agent';
import ThinkingBlock from './ThinkingBlock';
import ToolCallCard from './ToolCallCard';

interface ChatMessageProps {
    message: ChatMessageType;
}

export default function ChatMessage({ message }: ChatMessageProps) {
    const isUser = message.role === 'user';

    return (
        <div className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : ''}`}>
            {/* Avatar */}
            <div className={`
                flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center mt-0.5
                ${isUser ? 'bg-violet-500/20' : 'bg-emerald-500/20'}
            `}>
                {isUser ? (
                    <User size={14} className="text-violet-400" />
                ) : (
                    <Bot size={14} className="text-emerald-400" />
                )}
            </div>

            {/* Content */}
            <div className={`
                flex-1 min-w-0 rounded-xl px-3.5 py-2.5 text-sm leading-relaxed
                ${isUser
                    ? 'bg-violet-500/10 text-violet-100 border border-violet-500/20'
                    : 'bg-zinc-800/50 text-zinc-200 border border-white/5'
                }
            `}>
                {/* Reasoning (collapsible) */}
                {!isUser && message.reasoning && (
                    <ThinkingBlock text={message.reasoning} isStreaming={message.isStreaming} />
                )}

                {/* Text content */}
                <p className="whitespace-pre-wrap break-words">{message.content}</p>

                {/* Tool calls */}
                {message.toolCalls && message.toolCalls.length > 0 && (
                    <div className="mt-2.5 space-y-1.5">
                        {message.toolCalls.map((tc) => (
                            <ToolCallCard key={tc.id} toolCall={tc} />
                        ))}
                    </div>
                )}

                {/* Timestamp */}
                <span className="text-[10px] text-zinc-600 mt-1.5 block">
                    {new Date(message.timestamp).toLocaleTimeString()}
                </span>
            </div>
        </div>
    );
}
