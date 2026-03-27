'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useEditorStore } from '@/lib/store';
import { Send, Bot, User, Wrench, Loader2, Sparkles, AlertCircle, Box, Square, Coins, ChevronDown, Brain, ChevronRight } from 'lucide-react';
import type { ChatMessage } from '@/types/agent';

type AgentProvider = 'claude' | 'gpt' | 'kimi';

const PROVIDERS: Record<AgentProvider, { label: string; color: string; bg: string; border: string }> = {
    claude: { label: 'Claude Sonnet 4.6', color: 'text-violet-300', bg: 'bg-violet-500/20', border: 'border-violet-500/30' },
    gpt: { label: 'GPT-4o', color: 'text-green-300', bg: 'bg-green-500/20', border: 'border-green-500/30' },
    kimi: { label: 'Moonshot 128K', color: 'text-blue-300', bg: 'bg-blue-500/20', border: 'border-blue-500/30' },
};

type GameMode = '2d' | '3d';

// ── Storage key for message persistence ───────────────────────────
function getStorageKey(projectId: string) {
    return `axiom-chat-${projectId}`;
}

function saveMessages(projectId: string, messages: ChatMessage[], conversationId: string | null) {
    try {
        localStorage.setItem(getStorageKey(projectId), JSON.stringify({
            messages: messages.map(m => ({ ...m, isStreaming: false })),
            conversationId,
        }));
    } catch { /* quota exceeded, ignore */ }
}

function loadMessages(projectId: string): { messages: ChatMessage[]; conversationId: string | null } | null {
    try {
        const raw = localStorage.getItem(getStorageKey(projectId));
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

// ── Reasoning Block (collapsible, like Claude Code) ───────────────

function ReasoningBlock({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
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
                <div className="mt-1.5 ml-5 pl-2.5 border-l border-zinc-800 text-[11px] text-zinc-500 leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto">
                    {text}
                </div>
            )}
        </div>
    );
}

// ── Message Bubble ────────────────────────────────────────────────

function MessageBubble({ message }: { message: ChatMessage }) {
    const isUser = message.role === 'user';

    return (
        <div className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : ''}`}>
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
            <div className={`
        flex-1 rounded-xl px-3.5 py-2.5 text-sm leading-relaxed
        ${isUser
                    ? 'bg-violet-500/10 text-violet-100 border border-violet-500/20'
                    : 'bg-zinc-800/50 text-zinc-200 border border-white/5'
                }
      `}>
                {/* Reasoning block (collapsible) */}
                {!isUser && message.reasoning && (
                    <ReasoningBlock text={message.reasoning} isStreaming={message.isStreaming} />
                )}

                <p className="whitespace-pre-wrap">{message.content}</p>

                {/* Tool calls display */}
                {message.toolCalls && message.toolCalls.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                        {message.toolCalls.map((tc) => (
                            <div
                                key={tc.id}
                                className="flex items-center gap-2 px-2.5 py-1.5 bg-black/30 rounded-lg text-xs"
                            >
                                {tc.status === 'running' ? (
                                    <Loader2 size={12} className="text-amber-400 animate-spin" />
                                ) : (
                                    <Wrench size={12} className={tc.status === 'completed' ? 'text-emerald-500' : 'text-zinc-500'} />
                                )}
                                <span className="text-zinc-400 font-mono">{tc.name}</span>
                                {tc.filesModified && tc.filesModified.length > 0 && (
                                    <span className="text-zinc-600 text-[10px]">{tc.filesModified.join(', ')}</span>
                                )}
                                <span className={`ml-auto ${tc.status === 'completed' ? 'text-emerald-400' :
                                    tc.status === 'failed' ? 'text-red-400' :
                                        'text-amber-400'
                                    }`}>
                                    {tc.status}
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                <span className="text-[10px] text-zinc-600 mt-1 block">
                    {new Date(message.timestamp).toLocaleTimeString()}
                </span>
            </div>
        </div>
    );
}

// ── Provider Selector ──────────────────────────────────────────────

function ProviderSelector({ provider, onChange }: { provider: AgentProvider; onChange: (p: AgentProvider) => void }) {
    const [open, setOpen] = useState(false);
    const current = PROVIDERS[provider];

    return (
        <div className="relative">
            <button
                onClick={() => setOpen(!open)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all ${current.bg} ${current.color} ${current.border}`}
            >
                {current.label}
                <ChevronDown size={10} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
                <div className="absolute top-full right-0 mt-1 w-44 bg-zinc-900 border border-white/10 rounded-lg shadow-xl z-50 overflow-hidden">
                    {(Object.keys(PROVIDERS) as AgentProvider[]).map((key) => {
                        const p = PROVIDERS[key];
                        return (
                            <button
                                key={key}
                                onClick={() => { onChange(key); setOpen(false); }}
                                className={`w-full text-left px-3 py-2 text-xs font-medium transition-colors hover:bg-white/5 ${provider === key ? `${p.color} ${p.bg}` : 'text-zinc-400'}`}
                            >
                                {p.label}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ── Mode Selector ──────────────────────────────────────────────────

function ModeSelector({ mode, onChange }: { mode: GameMode; onChange: (m: GameMode) => void }) {
    return (
        <div className="flex items-center gap-1 p-0.5 bg-zinc-900/80 border border-white/5 rounded-lg">
            <button
                onClick={() => onChange('2d')}
                className={`
                    flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all
                    ${mode === '2d'
                        ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30 shadow-sm shadow-violet-500/10'
                        : 'text-zinc-500 hover:text-zinc-300'}
                `}
            >
                <Square size={12} />
                2D
            </button>
            <button
                onClick={() => onChange('3d')}
                className={`
                    flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all
                    ${mode === '3d'
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 shadow-sm shadow-amber-500/10'
                        : 'text-zinc-500 hover:text-zinc-300'}
                `}
            >
                <Box size={12} />
                3D
            </button>
        </div>
    );
}

// ── Main ChatPanel ─────────────────────────────────────────────────

interface ChatPanelProps {
    projectId: string;
}

export default function ChatPanel({ projectId }: ChatPanelProps) {
    const [input, setInput] = useState('');
    const [gameMode, setGameMode] = useState<GameMode>('2d');
    const [provider, setProvider] = useState<AgentProvider>('claude');
    const [conversationId, setConversationId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [showModeWarning, setShowModeWarning] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const { messages, isAgentBusy, addMessage, updateMessage, setAgentBusy, setMessages, addProjectFiles, refreshProjectFiles } = useEditorStore();

    // Load persisted messages on mount or when projectId changes
    useEffect(() => {
        const saved = loadMessages(projectId);
        if (saved && saved.messages.length > 0) {
            setMessages(saved.messages);
            setConversationId(saved.conversationId);
        } else {
            setMessages([]);
            setConversationId(null);
        }
        setLoaded(true);
    }, [projectId, setMessages]);

    // Persist messages whenever they change (skip during streaming)
    useEffect(() => {
        if (!loaded) return;
        const hasStreaming = messages.some(m => m.isStreaming);
        if (!hasStreaming && messages.length > 0) {
            saveMessages(projectId, messages, conversationId);
        }
    }, [messages, conversationId, projectId, loaded]);

    // Auto-scroll
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const handleModeChange = (mode: GameMode) => {
        setGameMode(mode);
        if (mode === '3d') {
            setShowModeWarning(true);
            setTimeout(() => setShowModeWarning(false), 4000);
        } else {
            setShowModeWarning(false);
        }
    };

    const handleClearChat = useCallback(() => {
        setMessages([]);
        setConversationId(null);
        localStorage.removeItem(getStorageKey(projectId));
    }, [projectId, setMessages]);

    const handleSend = async () => {
        if (!input.trim() || isAgentBusy) return;

        const userMessage: ChatMessage = {
            id: crypto.randomUUID(),
            role: 'user',
            content: input.trim(),
            timestamp: new Date().toISOString(),
        };

        addMessage(userMessage);
        setInput('');
        setAgentBusy(true);
        setError(null);

        // Create a placeholder assistant message that we'll update via streaming
        const assistantId = crypto.randomUUID();
        const toolCalls: ChatMessage['toolCalls'] = [];
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
                    message: userMessage.content,
                    conversation_id: conversationId,
                    game_mode: gameMode,
                    provider,
                }),
            });

            if (!res.ok) {
                const text = await res.text();
                try {
                    const errData = JSON.parse(text);
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
                                    if (data.conversation_id) setConversationId(data.conversation_id);
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
                                        content: `Working... (step ${data.iteration})`,
                                    });
                                    break;
                                case 'text':
                                    // Accumulate text from each iteration instead of replacing
                                    if (accumulatedContent) {
                                        accumulatedContent += '\n\n' + data.text;
                                    } else {
                                        accumulatedContent = data.text;
                                    }
                                    updateMessage(assistantId, {
                                        content: accumulatedContent,
                                    });
                                    break;
                                case 'tool_start':
                                    toolCalls!.push({
                                        id: data.id,
                                        name: data.name,
                                        status: 'running',
                                        input: data.input,
                                    });
                                    updateMessage(assistantId, {
                                        content: `Running ${data.name}...`,
                                        toolCalls: [...toolCalls!],
                                    });
                                    break;
                                case 'tool_result': {
                                    // Match by callId (data.id) for correct tool result pairing
                                    const matchIdx = toolCalls!.findIndex(tc => tc.id === data.id);
                                    const matched = matchIdx !== -1 ? toolCalls![matchIdx] : toolCalls![toolCalls!.length - 1];
                                    if (matched) {
                                        matched.status = data.status;
                                        matched.output = data.output;
                                        matched.error = data.error;
                                        matched.filesModified = data.filesModified;
                                    }
                                    updateMessage(assistantId, {
                                        toolCalls: [...toolCalls!],
                                    });
                                    // Inject files directly into store from stream data
                                    if (data.fileContents && data.fileContents.length > 0) {
                                        addProjectFiles(data.fileContents);
                                    }
                                    break;
                                }
                                case 'done': {
                                    // Use accumulated content from iterations, fall back to final response
                                    let content = accumulatedContent || data.response || 'No response';
                                    if (data.meta) {
                                        const meta = data.meta;
                                        const modeBadge = gameMode === '3d' ? '3D' : '2D';
                                        content += `\n\n_${modeBadge} · ${meta.toolsExecuted} tools · ${meta.creditsUsed} credits · ${meta.iterations} iterations_`;
                                    }
                                    updateMessage(assistantId, {
                                        content,
                                        toolCalls: [...toolCalls!],
                                        reasoning: reasoningText || undefined,
                                        isStreaming: false,
                                    });
                                    // Sync files from Supabase after agent finishes
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
                        } catch {
                            // Ignore malformed SSE data
                        }
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

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div className="h-full flex flex-col bg-zinc-950/50">
            {/* Header */}
            <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-white/5">
                <div className="flex items-center gap-2">
                    <Sparkles size={14} className="text-violet-400" />
                    <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                        AI Agent
                    </span>
                    {isAgentBusy && (
                        <Loader2 size={12} className="text-violet-400 animate-spin" />
                    )}
                </div>
                <div className="flex items-center gap-2">
                    {messages.length > 0 && !isAgentBusy && (
                        <button
                            onClick={handleClearChat}
                            className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors px-1.5 py-0.5"
                        >
                            Clear
                        </button>
                    )}
                    <ProviderSelector provider={provider} onChange={setProvider} />
                    <ModeSelector mode={gameMode} onChange={handleModeChange} />
                </div>
            </div>

            {/* 3D Token Warning */}
            {showModeWarning && (
                <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2 animate-fade-in">
                    <Coins size={14} className="text-amber-400 flex-shrink-0" />
                    <p className="text-xs text-amber-300">
                        <span className="font-semibold">3D mode enabled.</span> 3D operations cost <span className="font-bold text-amber-200">3x more credits</span>.
                    </p>
                </div>
            )}

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
                                ? 'Tell me what 3D game to build: FPS, racing, adventure... I\'ll create cameras, lights, and 3D models.'
                                : 'Tell me what 2D game to build: platformer, RPG, puzzle... I\'ll create sprites, scenes, and scripts.'}
                        </p>
                        {gameMode === '3d' && (
                            <div className="mt-3 px-2.5 py-1.5 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-center gap-1.5">
                                <Coins size={10} className="text-amber-400" />
                                <span className="text-[10px] text-amber-400 font-medium">3x credits vs 2D</span>
                            </div>
                        )}
                    </div>
                )}

                {messages.map((msg) => (
                    <MessageBubble key={msg.id} message={msg} />
                ))}

                {error && (
                    <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-300 animate-fade-in">
                        <AlertCircle size={12} />
                        {error}
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="p-3 border-t border-white/5">
                {/* Mode indicator in input area */}
                <div className="flex items-center gap-1.5 mb-2">
                    <div className={`w-1.5 h-1.5 rounded-full ${gameMode === '3d' ? 'bg-amber-400' : 'bg-violet-400'}`} />
                    <span className={`text-[10px] font-medium ${gameMode === '3d' ? 'text-amber-500' : 'text-violet-500'}`}>
                        {gameMode === '3d' ? '3D Mode · 3x credits' : '2D Mode · 1x credits'}
                    </span>
                </div>
                <div className="flex items-end gap-2 bg-zinc-900/80 border border-white/10 rounded-xl px-3 py-2 focus-within:border-violet-500/50 transition-colors">
                    <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={gameMode === '3d'
                            ? 'Describe your 3D game idea...'
                            : 'Describe your 2D game idea...'}
                        rows={1}
                        className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 resize-none outline-none max-h-32"
                        style={{ minHeight: '24px' }}
                    />
                    <button
                        onClick={handleSend}
                        disabled={!input.trim() || isAgentBusy}
                        className={`flex-shrink-0 p-1.5 rounded-lg transition-colors disabled:opacity-30 ${gameMode === '3d'
                            ? 'bg-amber-500 hover:bg-amber-400 disabled:hover:bg-amber-500'
                            : 'bg-violet-500 hover:bg-violet-400 disabled:hover:bg-violet-500'
                            }`}
                    >
                        <Send size={14} className="text-white" />
                    </button>
                </div>
            </div>
        </div>
    );
}
