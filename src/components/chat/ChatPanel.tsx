'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useEditorStore } from '@/lib/store';
import { Bot, Box, AlertCircle } from 'lucide-react';
import type { ChatMessage as ChatMessageType, ToolCallDisplay } from '@/types/agent';
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
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const {
        messages, isAgentBusy, chatView,
        activeConversationId,
        addMessage, updateMessage, setAgentBusy, setMessages,
        addProjectFiles, refreshProjectFiles,
        setChatView, setActiveConversationId, newConversation, loadConversations,
    } = useEditorStore();

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
        const toolCalls: ToolCallDisplay[] = [];
        let reasoningText = '';
        let accumulatedContent = '';

        addMessage({
            id: assistantId,
            role: 'assistant',
            content: 'Thinking...',
            toolCalls: [],
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

                                case 'reasoning':
                                    reasoningText += (reasoningText ? '\n' : '') + data.text;
                                    updateMessage(assistantId, {
                                        content: 'Reasoning...',
                                        reasoning: reasoningText,
                                    });
                                    break;

                                case 'iteration':
                                    updateMessage(assistantId, {
                                        content: accumulatedContent || `Working... (step ${data.iteration})`,
                                    });
                                    break;

                                case 'text':
                                    accumulatedContent = accumulatedContent
                                        ? accumulatedContent + data.text
                                        : data.text;
                                    updateMessage(assistantId, { content: accumulatedContent });
                                    break;

                                case 'tool_start':
                                    toolCalls.push({
                                        id: data.id,
                                        name: data.name,
                                        status: 'running',
                                        input: data.input,
                                    });
                                    updateMessage(assistantId, {
                                        content: accumulatedContent || `Running ${data.name}...`,
                                        toolCalls: [...toolCalls],
                                    });
                                    break;

                                case 'tool_result': {
                                    const matched = toolCalls.find(tc => tc.id === data.id)
                                        ?? toolCalls[toolCalls.length - 1];
                                    if (matched) {
                                        matched.status = data.status;
                                        matched.output = data.output;
                                        matched.error = data.error;
                                        matched.filesModified = data.filesModified;
                                    }
                                    updateMessage(assistantId, { toolCalls: [...toolCalls] });
                                    if (data.fileContents?.length > 0) {
                                        addProjectFiles(data.fileContents);
                                    }
                                    break;
                                }

                                case 'done': {
                                    let content = accumulatedContent || data.response || 'Done.';
                                    if (data.meta) {
                                        const m = data.meta;
                                        const badge = gameMode === '3d' ? '3D' : '2D';
                                        content += `\n\n_${badge} · ${m.toolsExecuted} tools · ${m.creditsUsed} credits · ${m.iterations} steps_`;
                                    }
                                    updateMessage(assistantId, {
                                        content,
                                        toolCalls: [...toolCalls],
                                        reasoning: reasoningText || undefined,
                                        isStreaming: false,
                                    });
                                    refreshProjectFiles(projectId);
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
                    <ChatMessageComponent key={msg.id} message={msg} />
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
