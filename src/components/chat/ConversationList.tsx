'use client';

import { useEffect } from 'react';
import { useEditorStore } from '@/lib/store';
import { MessageSquare, Loader2, Trash2, ArrowLeft } from 'lucide-react';
import type { ConversationSummary } from '@/types/agent';

interface ConversationListProps {
    projectId: string;
}

function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString();
}

function ConversationItem({
    conversation,
    isActive,
    onSelect,
    onDelete,
}: {
    conversation: ConversationSummary;
    isActive: boolean;
    onSelect: () => void;
    onDelete: () => void;
}) {
    return (
        <button
            onClick={onSelect}
            className={`
                w-full text-left px-3 py-2.5 rounded-lg transition-colors group
                ${isActive
                    ? 'bg-violet-500/15 border border-violet-500/30'
                    : 'hover:bg-white/5 border border-transparent'
                }
            `}
        >
            <div className="flex items-start gap-2">
                <MessageSquare size={13} className={`mt-0.5 flex-shrink-0 ${isActive ? 'text-violet-400' : 'text-zinc-600'}`} />
                <div className="flex-1 min-w-0">
                    <p className={`text-xs font-medium truncate ${isActive ? 'text-violet-200' : 'text-zinc-300'}`}>
                        {conversation.title || 'Untitled conversation'}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-zinc-600">
                            {conversation.messageCount} msgs
                        </span>
                        <span className="text-[10px] text-zinc-700">
                            {timeAgo(conversation.lastMessageAt)}
                        </span>
                    </div>
                </div>
                <button
                    onClick={(e) => { e.stopPropagation(); onDelete(); }}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-500/20 rounded transition-all"
                    title="Delete conversation"
                >
                    <Trash2 size={11} className="text-zinc-600 hover:text-red-400" />
                </button>
            </div>
        </button>
    );
}

export default function ConversationList({ projectId }: ConversationListProps) {
    const {
        conversations,
        activeConversationId,
        isLoadingConversations,
        loadConversations,
        switchConversation,
        newConversation,
        setChatView,
        setConversations,
    } = useEditorStore();

    useEffect(() => {
        loadConversations(projectId);
    }, [projectId, loadConversations]);

    const handleDelete = async (convId: string) => {
        try {
            const res = await fetch(`/api/projects/${projectId}/conversations/${convId}`, { method: 'DELETE' });
            if (res.ok) {
                setConversations(conversations.filter(c => c.id !== convId));
                if (activeConversationId === convId) {
                    newConversation();
                }
            }
        } catch { /* silent */ }
    };

    return (
        <div className="h-full flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/5">
                <button
                    onClick={() => setChatView('chat')}
                    className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                    <ArrowLeft size={12} />
                    Back
                </button>
                <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                    History
                </span>
                <button
                    onClick={() => { newConversation(); setChatView('chat'); }}
                    className="text-[10px] text-violet-400 hover:text-violet-300 font-medium transition-colors"
                >
                    + New
                </button>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1 scrollbar-thin scrollbar-thumb-zinc-800">
                {isLoadingConversations ? (
                    <div className="flex items-center justify-center py-8">
                        <Loader2 size={16} className="text-zinc-600 animate-spin" />
                    </div>
                ) : conversations.length === 0 ? (
                    <div className="text-center py-8">
                        <MessageSquare size={20} className="text-zinc-700 mx-auto mb-2" />
                        <p className="text-xs text-zinc-600">No conversations yet</p>
                    </div>
                ) : (
                    conversations.map((conv) => (
                        <ConversationItem
                            key={conv.id}
                            conversation={conv}
                            isActive={conv.id === activeConversationId}
                            onSelect={() => switchConversation(conv.id, projectId)}
                            onDelete={() => handleDelete(conv.id)}
                        />
                    ))
                )}
            </div>
        </div>
    );
}
