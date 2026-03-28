'use client';

import { useState } from 'react';
import { Send } from 'lucide-react';

interface ChatInputProps {
    onSend: (message: string) => void;
    disabled: boolean;
    gameMode: '2d' | '3d';
}

export default function ChatInput({ onSend, disabled, gameMode }: ChatInputProps) {
    const [input, setInput] = useState('');

    const handleSend = () => {
        const trimmed = input.trim();
        if (!trimmed || disabled) return;
        onSend(trimmed);
        setInput('');
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div className="p-3 border-t border-white/5">
            <div className="flex items-center gap-1.5 mb-2">
                <div className={`w-1.5 h-1.5 rounded-full ${gameMode === '3d' ? 'bg-amber-400' : 'bg-violet-400'}`} />
                <span className={`text-[10px] font-medium ${gameMode === '3d' ? 'text-amber-500' : 'text-violet-500'}`}>
                    {gameMode === '3d' ? '3D Mode' : '2D Mode'}
                </span>
            </div>
            <div className="flex items-end gap-2 bg-zinc-900/80 border border-white/10 rounded-xl px-3 py-2 focus-within:border-violet-500/50 transition-colors">
                <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={gameMode === '3d' ? 'Describe your 3D game...' : 'Describe your 2D game...'}
                    rows={1}
                    className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 resize-none outline-none max-h-32"
                    style={{ minHeight: '24px' }}
                />
                <button
                    onClick={handleSend}
                    disabled={!input.trim() || disabled}
                    className={`flex-shrink-0 p-1.5 rounded-lg transition-colors disabled:opacity-30
                        ${gameMode === '3d'
                            ? 'bg-amber-500 hover:bg-amber-400 disabled:hover:bg-amber-500'
                            : 'bg-violet-500 hover:bg-violet-400 disabled:hover:bg-violet-500'
                        }`}
                >
                    <Send size={14} className="text-white" />
                </button>
            </div>
        </div>
    );
}
