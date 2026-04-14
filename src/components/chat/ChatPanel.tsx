'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useEditorStore } from '@/lib/store';
import { Bot, Box, AlertCircle } from 'lucide-react';
import type { ChatMessage as ChatMessageType } from '@/types/agent';
import ChatHeader from './ChatHeader';
import ChatMessageComponent from './ChatMessage';
import ChatInput from './ChatInput';
import ConversationList from './ConversationList';

type AgentProvider = 'claude' | 'gpt' | 'kimi';
type GameMode = '2d' | '3d';

// ── LocalStorage persistence ──────────────────────────────────────

function getStorageKey(projectId: string) {
    return `axiom-chat-${projectId}`;
}

function saveSession(projectId: string, messages: ChatMessageType[], conversationId: string | null) {
    try {
        localStorage.setItem(getStorageKey(projectId), JSON.stringify({
            messages: messages.map(m => ({ ...m, isStreaming: false })),
            conversationId,
        }));
    } catch { /* quota exceeded */ }
}

function loadSession(projectId: string): { messages: ChatMessageType[]; conversationId: string | null } | null {
    try {
        const raw = localStorage.getItem(getStorageKey(projectId));
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

// ── Main ChatPanel ─────────────────────────────────────────────────

interface ChatPanelProps {
    projectId: string;
}

export default function ChatPanel({ projectId }: ChatPanelProps) {
    const [gameMode, setGameMode] = useState<GameMode>('2d');
    const [provider, setProvider] = useState<AgentProvider>('claude');
    const [error, setError] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [pendingPermissions, setPendingPermissions] = useState<Record<string, { patterns: string[] }>>({});
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const {
        messages, isAgentBusy, chatView,
        activeConversationId,
        addMessage, updateMessage, setAgentBusy, setMessages,
        addProjectFiles, refreshProjectFiles, loadAssets,
        setChatView, setActiveConversationId, newConversation, loadConversations,
    } = useEditorStore();

    const handleRespondPermission = async (toolName: string, granted: boolean) => {
        setPendingPermissions(prev => {
            const next = { ...prev };
            delete next[toolName];
            return next;
        });
        fetch('/api/agent/permission', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toolName, granted })
        }).catch(err => console.error('Failed to submit permission', err));
    };

    // Restore session from localStorage on mount
    useEffect(() => {
        const saved = loadSession(projectId);
        if (saved && saved.messages.length > 0) {
            setMessages(saved.messages);
            setActiveConversationId(saved.conversationId);
        } else {
            setMessages([]);
            setActiveConversationId(null);
        }
        setLoaded(true);
    }, [projectId, setMessages, setActiveConversationId]);

    // Persist to localStorage when messages change (skip during streaming)
    useEffect(() => {
        if (!loaded) return;
        const hasStreaming = messages.some(m => m.isStreaming);
        if (!hasStreaming && messages.length > 0) {
            saveSession(projectId, messages, activeConversationId);
        }
    }, [messages, activeConversationId, projectId, loaded]);

    // Auto-scroll to bottom
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const handleClearChat = useCallback(() => {
        newConversation();
        localStorage.removeItem(getStorageKey(projectId));
    }, [projectId, newConversation]);

    const handleShowHistory = useCallback(() => {
        loadConversations(projectId);
        setChatView('history');
    }, [projectId, loadConversations, setChatView]);

    const handleNewChat = useCallback(() => {
        newConversation();
        localStorage.removeItem(getStorageKey(projectId));
    }, [projectId, newConversation]);

    // ── Send message with SSE streaming ────────────────────────────

    const handleSend = async (text: string) => {
        if (isAgentBusy) return;

        const userMessage: ChatMessageType = {
            id: crypto.randomUUID(),
            role: 'user',
            content: text,
            timestamp: new Date().toISOString(),
        };

        addMessage(userMessage);
        setAgentBusy(true);
        setError(null);

        const assistantId = crypto.randomUUID();
        const blocks: import('@/types/agent').ContentBlock[] = [];
        let accumulatedContent = '';

        addMessage({
            id: assistantId,
            role: 'assistant',
            content: 'Thinking...',
            blocks: [],
            timestamp: new Date().toISOString(),
            isStreaming: true,
        });

        try {
            const res = await fetch('/api/agent/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project_id: projectId,
                    message: text,
                    conversation_id: activeConversationId,
                    game_mode: gameMode,
                    provider,
                }),
            });

            if (!res.ok) {
                const errText = await res.text();
                try {
                    const errData = JSON.parse(errText);
                    setError(errData.error || `Server error (${res.status})`);
                } catch {
                    setError(`Server error (${res.status})`);
                }
                updateMessage(assistantId, { content: 'Error occurred.', isStreaming: false });
                return;
            }

            // Parse SSE stream
            const reader = res.body?.getReader();
            if (!reader) {
                setError('No response stream');
                return;
            }

            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                let eventType = '';
                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        eventType = line.slice(7);
                    } else if (line.startsWith('data: ') && eventType) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            switch (eventType) {
                                case 'init':
                                    if (data.conversation_id) {
                                        setActiveConversationId(data.conversation_id);
                                    }
                                    break;

                                case 'subsystem':
                                    if (data.event === 'context.compacted') {
                                        addMessage({
                                            id: crypto.randomUUID(),
                                            role: 'assistant',
                                            content: `[Context Compressed] Saved ${data.tokensSaved} tokens. Older messages were summarized.`,
                                            timestamp: new Date().toISOString(),
                                        });
                                    } else if (data.event === 'permission.request') {
                                        setPendingPermissions(prev => ({
                                            ...prev,
                                            [data.toolName]: { patterns: data.patterns }
                                        }));
                                    }
                                    break;

                                case 'reasoning': {
                                    // Fallback: server sends reasoning as separate event
                                    let tb = blocks.find(b => b.type === 'thinking');
                                    if (!tb) {
                                        tb = { type: 'thinking', text: data.text, isStreaming: true };
                                        blocks.unshift(tb);
                                    } else if (tb.type === 'thinking') {
                                        tb.text += (tb.text ? '\n' : '') + data.text;
                                    }
                                    updateMessage(assistantId, { blocks: [...blocks] });
                                    break;
                                }

                                case 'text': {
                                    // Fallback: server sends text as separate event
                                    const lastText = blocks.findLast(b => b.type === 'text');
                                    if (lastText && lastText.type === 'text') {
                                        lastText.text += data.text;
                                    } else {
                                        blocks.push({ type: 'text', text: data.text });
                                    }
                                    accumulatedContent = blocks
                                        .filter(b => b.type === 'text')
                                        .map(b => b.type === 'text' ? b.text : '')
                                        .join('');
                                    updateMessage(assistantId, { content: accumulatedContent, blocks: [...blocks] });
                                    break;
                                }

                                case 'iteration': {
                                    // Progress update — no block needed, just update content
                                    if (!accumulatedContent) {
                                        updateMessage(assistantId, { content: `Working... (step ${data.iteration})` });
                                    }
                                    break;
                                }

                                case 'stream_event': {
                                    const chunk = data as import('@/types/agent').StreamEvent;
                                    if (chunk.type === 'content_block_start') {
                                        if (chunk.block.type === 'text') {
                                            blocks.push({ type: 'text', text: '' });
                                        } else if (chunk.block.type === 'tool_use') {
                                            blocks.push({
                                                type: 'tool_use',
                                                toolCall: { id: chunk.block.id, name: chunk.block.name, status: 'pending', input: {} }
                                            });
                                        }
                                    } else if (chunk.type === 'content_block_delta') {
                                        if ('text' in chunk.delta && chunk.delta.type === 'text_delta') {
                                            const last = blocks[blocks.length - 1];
                                            if (last?.type === 'text') last.text += chunk.delta.text;
                                            accumulatedContent = blocks
                                                .filter(b => b.type === 'text')
                                                .map(b => b.type === 'text' ? b.text : '')
                                                .join('');
                                        } else if ('text' in chunk.delta && chunk.delta.type === 'reasoning_delta') {
                                            let tb = blocks.find(b => b.type === 'thinking');
                                            if (!tb) {
                                                tb = { type: 'thinking', text: chunk.delta.text, isStreaming: true };
                                                blocks.unshift(tb);
                                            } else if (tb.type === 'thinking') {
                                                tb.text += chunk.delta.text;
                                            }
                                        }
                                    } else if (chunk.type === 'content_block_stop') {
                                        const tb = blocks.find(b => b.type === 'thinking');
                                        if (tb && tb.type === 'thinking') tb.isStreaming = false;
                                    }
                                    updateMessage(assistantId, { blocks: [...blocks] });
                                    break;
                                }

                                case 'tool_start': {
                                    const block = blocks.find(b => b.type === 'tool_use' && b.toolCall.id === data.id);
                                    if (block && block.type === 'tool_use') {
                                        block.toolCall.status = 'running';
                                        block.toolCall.input = data.input;
                                    } else {
                                        blocks.push({ type: 'tool_use', toolCall: { id: data.id, name: data.name, status: 'running', input: data.input } });
                                    }
                                    updateMessage(assistantId, { blocks: [...blocks] });
                                    break;
                                }

                                case 'tool_result': {
                                    const block = blocks.find(b => b.type === 'tool_use' && b.toolCall.id === data.id);
                                    if (block && block.type === 'tool_use') {
                                        block.toolCall.status = data.status;
                                        block.toolCall.output = data.output;
                                        block.toolCall.error = data.error;
                                        block.toolCall.filesModified = data.filesModified;
                                    }
                                    updateMessage(assistantId, { blocks: [...blocks] });
                                    if (data.fileContents?.length > 0) {
                                        addProjectFiles(data.fileContents);
                                    }
                                    break;
                                }

                                case 'done': {
                                    let content = accumulatedContent || data.response || 'Done.';
                                    // Mark all thinking blocks as done
                                    for (const b of blocks) {
                                        if (b.type === 'thinking') b.isStreaming = false;
                                    }
                                    // Append meta as a final text block
                                    if (data.meta) {
                                        const m = data.meta;
                                        const badge = gameMode === '3d' ? '3D' : '2D';
                                        const metaText = `\n_${badge} · ${m.toolsExecuted} tools · ${m.creditsUsed} credits · ${m.iterations} steps_`;
                                        content += '\n' + metaText;
                                    }
                                    updateMessage(assistantId, {
                                        content,
                                        blocks: [...blocks],
                                        isStreaming: false,
                                    });
                                    refreshProjectFiles(projectId);
                                    // Refresh assets too so newly-generated maps/sprites appear
                                    // in their studios without a manual reload.
                                    loadAssets(projectId);
                                    break;
                                }

                                case 'error':
                                    setError(data.error || 'Agent error');
                                    updateMessage(assistantId, {
                                        content: `Error: ${data.error}`,
                                        isStreaming: false,
                                    });
                                    break;
                            }
                        } catch { /* malformed SSE data */ }
                        eventType = '';
                    }
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            setError(`Network error: ${msg}`);
            updateMessage(assistantId, { content: 'Connection lost.', isStreaming: false });
        } finally {
            setAgentBusy(false);
        }
    };

    // ── Render ─────────────────────────────────────────────────────

    if (chatView === 'history') {
        return (
            <div className="h-full flex flex-col bg-zinc-950/50">
                <ConversationList projectId={projectId} />
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col bg-zinc-950/50">
            <ChatHeader
                provider={provider}
                onProviderChange={setProvider}
                gameMode={gameMode}
                onGameModeChange={setGameMode}
                isAgentBusy={isAgentBusy}
                hasMessages={messages.length > 0}
                onClearChat={handleClearChat}
                onShowHistory={handleShowHistory}
                onNewChat={handleNewChat}
            />

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-thin scrollbar-thumb-zinc-800">
                {messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-center px-4">
                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 flex items-center justify-center mb-3">
                            {gameMode === '3d' ? (
                                <Box size={24} className="text-amber-400" />
                            ) : (
                                <Bot size={24} className="text-violet-400" />
                            )}
                        </div>
                        <p className="text-sm text-zinc-400 mb-1">
                            Axiom AI Agent — <span className={gameMode === '3d' ? 'text-amber-400' : 'text-violet-400'}>{gameMode.toUpperCase()}</span>
                        </p>
                        <p className="text-xs text-zinc-600 leading-relaxed max-w-[260px]">
                            {gameMode === '3d'
                                ? "Tell me what 3D game to build. I'll create cameras, lights, and models."
                                : "Tell me what 2D game to build. I'll create sprites, scenes, and scripts."}
                        </p>
                    </div>
                )}

                {messages.map((msg) => (
                    <ChatMessageComponent
                        key={msg.id}
                        message={msg}
                        pendingPermissions={pendingPermissions}
                        onRespondPermission={handleRespondPermission}
                    />
                ))}

                {error && (
                    <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-300 animate-fade-in">
                        <AlertCircle size={12} />
                        {error}
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            <ChatInput
                onSend={handleSend}
                disabled={isAgentBusy}
                gameMode={gameMode}
            />
        </div>
    );
}
