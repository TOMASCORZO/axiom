'use client';

import { useEditorStore } from '@/lib/store';
import {
    Terminal,
    Hammer,
    AlertTriangle,
    Trash2,
    AlertCircle,
    Info,
} from 'lucide-react';

export default function ConsolePanel() {
    const {
        consoleEntries,
        clearConsole,
        activeBottomTab,
        setActiveBottomTab,
    } = useEditorStore();

    const tabs = [
        { id: 'console' as const, label: 'Console', icon: Terminal },
        { id: 'build' as const, label: 'Build', icon: Hammer },
        { id: 'errors' as const, label: 'Errors', icon: AlertTriangle },
    ];

    const getLevelIcon = (level: string) => {
        switch (level) {
            case 'error': return <AlertCircle size={12} className="text-red-400 flex-shrink-0" />;
            case 'warn': return <AlertTriangle size={12} className="text-amber-400 flex-shrink-0" />;
            default: return <Info size={12} className="text-zinc-500 flex-shrink-0" />;
        }
    };

    const getLevelColor = (level: string) => {
        switch (level) {
            case 'error': return 'text-red-300';
            case 'warn': return 'text-amber-300';
            case 'debug': return 'text-zinc-500';
            default: return 'text-zinc-300';
        }
    };

    // Filter entries by active tab
    const filteredEntries = activeBottomTab === 'errors'
        ? consoleEntries.filter((e) => e.level === 'error' || e.level === 'warn')
        : consoleEntries;

    return (
        <div className="h-full flex flex-col bg-zinc-950/80 border-t border-white/5">
            {/* Tabs */}
            <div className="flex items-center justify-between px-2 border-b border-white/5">
                <div className="flex">
                    {tabs.map((tab) => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveBottomTab(tab.id)}
                            className={`
                flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors
                border-b-2 -mb-px
                ${activeBottomTab === tab.id
                                    ? 'text-violet-300 border-violet-500'
                                    : 'text-zinc-500 border-transparent hover:text-zinc-300'
                                }
              `}
                        >
                            <tab.icon size={12} />
                            {tab.label}
                            {tab.id === 'errors' && consoleEntries.filter(e => e.level === 'error').length > 0 && (
                                <span className="ml-1 px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded-full text-[10px] font-bold">
                                    {consoleEntries.filter(e => e.level === 'error').length}
                                </span>
                            )}
                        </button>
                    ))}
                </div>

                <button
                    onClick={clearConsole}
                    className="p-1 hover:bg-white/10 rounded transition-colors"
                    title="Clear console"
                >
                    <Trash2 size={12} className="text-zinc-500" />
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto font-mono text-xs p-2 space-y-0.5 scrollbar-thin scrollbar-thumb-zinc-800">
                {filteredEntries.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                        <span className="text-zinc-600 text-xs">
                            {activeBottomTab === 'errors' ? 'No errors' : 'Console is empty'}
                        </span>
                    </div>
                ) : (
                    filteredEntries.map((entry) => (
                        <div key={entry.id} className="flex items-start gap-2 py-0.5 hover:bg-white/[0.02] rounded px-1">
                            {getLevelIcon(entry.level)}
                            <span className={`flex-1 ${getLevelColor(entry.level)}`}>
                                {entry.message}
                            </span>
                            {entry.source && (
                                <span className="text-zinc-600 flex-shrink-0">
                                    {entry.source}:{entry.line}
                                </span>
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
