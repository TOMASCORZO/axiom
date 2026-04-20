'use client';

import { useEditorStore } from '@/lib/store';
import { useRouter } from 'next/navigation';
import {
    Play,
    Pause,
    Square,
    Settings,
    Undo,
    Redo,
    Download,
    Maximize2,
    Save,
    ArrowLeft,
    ImageIcon,
    Map as MapIcon,
    Database as DatabaseIcon,
    Radio as RadioIcon,
} from 'lucide-react';

export default function Toolbar() {
    const router = useRouter();
    const { isPlaying, setIsPlaying, project, addConsoleEntry, activeRightPanel, setActiveRightPanel } = useEditorStore();

    const handlePlay = () => {
        const newState = !isPlaying;
        setIsPlaying(newState);
        addConsoleEntry({
            id: crypto.randomUUID(),
            level: 'log',
            message: newState ? '[Axiom] ▶ Game started' : '[Axiom] ⏸ Game paused',
            timestamp: new Date().toISOString(),
        });
    };

    const handleStop = () => {
        if (isPlaying) {
            setIsPlaying(false);
            addConsoleEntry({
                id: crypto.randomUUID(),
                level: 'log',
                message: '[Axiom] ■ Game stopped',
                timestamp: new Date().toISOString(),
            });
        }
    };

    const handleUndo = () => {
        addConsoleEntry({
            id: crypto.randomUUID(),
            level: 'debug',
            message: '[Axiom] Undo (engine bridge not connected)',
            timestamp: new Date().toISOString(),
        });
    };

    const handleRedo = () => {
        addConsoleEntry({
            id: crypto.randomUUID(),
            level: 'debug',
            message: '[Axiom] Redo (engine bridge not connected)',
            timestamp: new Date().toISOString(),
        });
    };

    const handleSave = () => {
        addConsoleEntry({
            id: crypto.randomUUID(),
            level: 'log',
            message: '[Axiom] Project saved',
            timestamp: new Date().toISOString(),
        });
    };

    return (
        <div className="flex items-center h-11 px-3 bg-zinc-950 border-b border-white/5 gap-1">
            {/* Back + Logo */}
            <div className="flex items-center gap-2 mr-4 pr-4 border-r border-white/10">
                <button
                    onClick={() => router.push('/dashboard')}
                    className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                    title="Back to dashboard"
                >
                    <ArrowLeft size={14} />
                </button>
                <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center">
                    <span className="text-white text-xs font-black">A</span>
                </div>
                <span className="text-sm font-semibold text-zinc-200 hidden sm:block">
                    {project?.name ?? 'Axiom'}
                </span>
            </div>

            {/* Playback Controls */}
            <div className="flex items-center gap-0.5 mr-3 pr-3 border-r border-white/10">
                <button
                    onClick={handlePlay}
                    className={`
            p-2 rounded-lg transition-all
            ${isPlaying
                            ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                            : 'bg-violet-500/20 text-violet-400 hover:bg-violet-500/30'
                        }
          `}
                    title={isPlaying ? 'Pause' : 'Run'}
                >
                    {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                </button>
                <button
                    onClick={handleStop}
                    className="p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                    title="Stop"
                >
                    <Square size={16} />
                </button>
            </div>

            {/* Edit Controls */}
            <div className="flex items-center gap-0.5 mr-3 pr-3 border-r border-white/10">
                <button onClick={handleUndo} className="p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors" title="Undo">
                    <Undo size={15} />
                </button>
                <button onClick={handleRedo} className="p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors" title="Redo">
                    <Redo size={15} />
                </button>
            </div>

            {/* Save */}
            <button
                onClick={handleSave}
                className="p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                title="Save project"
            >
                <Save size={15} />
            </button>

            {/* Asset Studio / Map Studio */}
            <div className="ml-2 pl-2 border-l border-white/10 flex items-center gap-0.5">
                <button
                    onClick={() => setActiveRightPanel(activeRightPanel === 'assets' ? 'chat' : 'assets')}
                    className={`p-2 rounded-lg transition-all ${
                        activeRightPanel === 'assets'
                            ? 'bg-violet-500/20 text-violet-400 hover:bg-violet-500/30'
                            : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
                    }`}
                    title="Asset Studio"
                >
                    <ImageIcon size={15} />
                </button>
                <button
                    onClick={() => setActiveRightPanel(activeRightPanel === 'maps' ? 'chat' : 'maps')}
                    className={`p-2 rounded-lg transition-all ${
                        activeRightPanel === 'maps'
                            ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                            : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
                    }`}
                    title="Map Studio"
                >
                    <MapIcon size={15} />
                </button>
                <button
                    onClick={() => setActiveRightPanel(activeRightPanel === 'database' ? 'chat' : 'database')}
                    className={`p-2 rounded-lg transition-all ${
                        activeRightPanel === 'database'
                            ? 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30'
                            : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
                    }`}
                    title="Database Studio"
                >
                    <DatabaseIcon size={15} />
                </button>
                <button
                    onClick={() => setActiveRightPanel(activeRightPanel === 'realtime' ? 'chat' : 'realtime')}
                    className={`p-2 rounded-lg transition-all ${
                        activeRightPanel === 'realtime'
                            ? 'bg-fuchsia-500/20 text-fuchsia-400 hover:bg-fuchsia-500/30'
                            : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
                    }`}
                    title="Realtime Studio"
                >
                    <RadioIcon size={15} />
                </button>
            </div>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Right Controls */}
            <div className="flex items-center gap-0.5">
                <button className="p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors" title="Fullscreen viewport">
                    <Maximize2 size={15} />
                </button>
                <button className="p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors" title="Export build">
                    <Download size={15} />
                </button>
                <button className="p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors" title="Settings">
                    <Settings size={15} />
                </button>
            </div>
        </div>
    );
}
