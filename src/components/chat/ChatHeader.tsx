'use client';

import { useState } from 'react';
import { Sparkles, Loader2, ChevronDown, Square, Box, Coins, History, Plus } from 'lucide-react';

type AgentProvider = 'claude' | 'gpt' | 'kimi';
type GameMode = '2d' | '3d';

const PROVIDERS: Record<AgentProvider, { label: string; color: string; bg: string; border: string }> = {
    claude: { label: 'Claude Sonnet 4.6', color: 'text-violet-300', bg: 'bg-violet-500/20', border: 'border-violet-500/30' },
    gpt: { label: 'GPT-4o', color: 'text-green-300', bg: 'bg-green-500/20', border: 'border-green-500/30' },
    kimi: { label: 'Kimi K2.5', color: 'text-blue-300', bg: 'bg-blue-500/20', border: 'border-blue-500/30' },
};

interface ChatHeaderProps {
    provider: AgentProvider;
    onProviderChange: (p: AgentProvider) => void;
    gameMode: GameMode;
    onGameModeChange: (m: GameMode) => void;
    isAgentBusy: boolean;
    hasMessages: boolean;
    onClearChat: () => void;
    onShowHistory: () => void;
    onNewChat: () => void;
}

export default function ChatHeader({
    provider, onProviderChange,
    gameMode, onGameModeChange,
    isAgentBusy, hasMessages,
    onClearChat, onShowHistory, onNewChat,
}: ChatHeaderProps) {
    const [providerOpen, setProviderOpen] = useState(false);
    const current = PROVIDERS[provider];

    return (
        <div className="border-b border-white/5">
            {/* Row 1: Title + Actions */}
            <div className="flex items-center justify-between px-3 py-2">
                <div className="flex items-center gap-2">
                    <Sparkles size={14} className="text-violet-400" />
                    <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                        AI Agent
                    </span>
                    {isAgentBusy && <Loader2 size={12} className="text-violet-400 animate-spin" />}
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={onShowHistory}
                        className="p-1.5 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                        title="Conversation history"
                    >
                        <History size={13} />
                    </button>
                    <button
                        onClick={onNewChat}
                        className="p-1.5 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                        title="New conversation"
                    >
                        <Plus size={13} />
                    </button>
                    {hasMessages && !isAgentBusy && (
                        <button
                            onClick={onClearChat}
                            className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors px-1.5 py-0.5"
                        >
                            Clear
                        </button>
                    )}
                </div>
            </div>

            {/* Row 2: Provider + Mode */}
            <div className="flex items-center gap-2 px-3 pb-2">
                {/* Provider selector */}
                <div className="relative">
                    <button
                        onClick={() => setProviderOpen(!providerOpen)}
                        className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium border transition-all ${current.bg} ${current.color} ${current.border}`}
                    >
                        {current.label}
                        <ChevronDown size={10} className={`transition-transform ${providerOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {providerOpen && (
                        <div className="absolute top-full left-0 mt-1 w-40 bg-zinc-900 border border-white/10 rounded-lg shadow-xl z-50 overflow-hidden">
                            {(Object.keys(PROVIDERS) as AgentProvider[]).map((key) => {
                                const p = PROVIDERS[key];
                                return (
                                    <button
                                        key={key}
                                        onClick={() => { onProviderChange(key); setProviderOpen(false); }}
                                        className={`w-full text-left px-3 py-2 text-[11px] font-medium transition-colors hover:bg-white/5 ${provider === key ? `${p.color} ${p.bg}` : 'text-zinc-400'}`}
                                    >
                                        {p.label}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Mode toggle */}
                <div className="flex items-center gap-0.5 p-0.5 bg-zinc-900/80 border border-white/5 rounded-md">
                    <button
                        onClick={() => onGameModeChange('2d')}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-all
                            ${gameMode === '2d'
                                ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                                : 'text-zinc-500 hover:text-zinc-300 border border-transparent'}`}
                    >
                        <Square size={10} /> 2D
                    </button>
                    <button
                        onClick={() => onGameModeChange('3d')}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-all
                            ${gameMode === '3d'
                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                : 'text-zinc-500 hover:text-zinc-300 border border-transparent'}`}
                    >
                        <Box size={10} /> 3D
                    </button>
                </div>

                {gameMode === '3d' && (
                    <div className="flex items-center gap-1">
                        <Coins size={10} className="text-amber-400" />
                        <span className="text-[10px] text-amber-400 font-medium">3x</span>
                    </div>
                )}
            </div>
        </div>
    );
}
