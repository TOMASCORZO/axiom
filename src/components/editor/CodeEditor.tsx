'use client';

import { useMemo } from 'react';
import { useEditorStore } from '@/lib/store';
import { X, Code, Gamepad2, Settings, Image, File } from 'lucide-react';

function getTabIcon(name: string) {
    const ext = name.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'axs': return <Code size={12} className="text-emerald-400" />;
        case 'scene': return <Gamepad2 size={12} className="text-violet-400" />;
        case 'res': case 'axiom': case 'cfg': return <Settings size={12} className="text-amber-400" />;
        case 'png': case 'jpg': case 'svg': return <Image size={12} className="text-sky-400" />;
        default: return <File size={12} className="text-zinc-400" />;
    }
}

/** Simple syntax highlighting for .axs and .scene files */
function highlightLine(line: string, ext: string): React.ReactNode {
    if (ext === 'axs') {
        // Keywords
        const keywords = /\b(extends|func|var|const|signal|if|else|elif|for|while|return|class|export|import|match|true|false|null|self|emit|await|yield)\b/g;
        // Comments
        if (line.trimStart().startsWith('#') || line.trimStart().startsWith('//')) {
            return <span className="text-zinc-600 italic">{line}</span>;
        }
        // Strings
        const parts: React.ReactNode[] = [];
        let lastIndex = 0;
        const combined = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b(?:extends|func|var|const|signal|if|else|elif|for|while|return|class|export|import|match|true|false|null|self|emit|await|yield)\b|\b\d+(?:\.\d+)?\b)/g;
        let match;
        while ((match = combined.exec(line)) !== null) {
            if (match.index > lastIndex) {
                parts.push(line.slice(lastIndex, match.index));
            }
            const m = match[0];
            if (m.startsWith('"') || m.startsWith("'")) {
                parts.push(<span key={match.index} className="text-amber-300">{m}</span>);
            } else if (keywords.test(m)) {
                keywords.lastIndex = 0;
                parts.push(<span key={match.index} className="text-violet-400 font-medium">{m}</span>);
            } else if (/^\d/.test(m)) {
                parts.push(<span key={match.index} className="text-sky-300">{m}</span>);
            } else {
                parts.push(m);
            }
            lastIndex = match.index + m.length;
        }
        if (lastIndex < line.length) {
            parts.push(line.slice(lastIndex));
        }
        return parts.length > 0 ? <>{parts}</> : line;
    }

    if (ext === 'scene') {
        if (line.trimStart().startsWith('[')) {
            return <span className="text-violet-400 font-medium">{line}</span>;
        }
        const eqIndex = line.indexOf('=');
        if (eqIndex > 0) {
            return (
                <>
                    <span className="text-sky-300">{line.slice(0, eqIndex)}</span>
                    <span className="text-zinc-500">=</span>
                    <span className="text-amber-300">{line.slice(eqIndex + 1)}</span>
                </>
            );
        }
    }

    return line;
}

export default function CodeEditor() {
    const { activeFile, openFiles, files, setActiveFile, closeFile } = useEditorStore();

    const activeFileData = useMemo(() => {
        if (!activeFile) return null;
        return files.find(f => f.path === activeFile) ?? null;
    }, [activeFile, files]);

    const ext = activeFile?.split('.').pop()?.toLowerCase() ?? '';

    const lines = useMemo(() => {
        if (!activeFileData?.text_content) return [];
        return activeFileData.text_content.split('\n');
    }, [activeFileData]);

    if (openFiles.length === 0) return null;

    return (
        <div className="h-full flex flex-col bg-zinc-950/80 border-b border-white/5">
            {/* Tab bar */}
            <div className="flex items-center bg-zinc-900/50 border-b border-white/5 overflow-x-auto scrollbar-none">
                {openFiles.map(filePath => {
                    const name = filePath.split('/').pop() ?? filePath;
                    const isActive = filePath === activeFile;
                    return (
                        <div
                            key={filePath}
                            className={`
                                group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer
                                border-r border-white/5 flex-shrink-0 transition-colors
                                ${isActive
                                    ? 'bg-zinc-950 text-zinc-200 border-b-2 border-b-violet-500'
                                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'}
                            `}
                            onClick={() => setActiveFile(filePath)}
                        >
                            {getTabIcon(name)}
                            <span className="max-w-[120px] truncate">{name}</span>
                            <button
                                onClick={(e) => { e.stopPropagation(); closeFile(filePath); }}
                                className="ml-1 p-0.5 rounded hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                                <X size={10} />
                            </button>
                        </div>
                    );
                })}
            </div>

            {/* Code content */}
            <div className="flex-1 overflow-auto scrollbar-thin scrollbar-thumb-zinc-800">
                {activeFileData ? (
                    <div className="font-mono text-[13px] leading-6">
                        {lines.map((line, i) => (
                            <div key={i} className="flex hover:bg-white/[0.02]">
                                <span className="flex-shrink-0 w-12 text-right pr-4 text-zinc-700 select-none text-xs leading-6">
                                    {i + 1}
                                </span>
                                <pre className="flex-1 text-zinc-300 whitespace-pre-wrap pr-4">
                                    {highlightLine(line, ext)}
                                </pre>
                            </div>
                        ))}
                        {lines.length === 0 && (
                            <div className="px-4 py-8 text-zinc-600 text-sm italic">
                                Empty file
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
                        File content not available
                    </div>
                )}
            </div>

            {/* Status bar */}
            {activeFileData && (
                <div className="flex items-center gap-4 px-3 py-1 bg-zinc-900/30 border-t border-white/5 text-[10px] text-zinc-600">
                    <span>{activeFile}</span>
                    <span>{lines.length} lines</span>
                    <span>{activeFileData.size_bytes} bytes</span>
                    <span className="uppercase">{ext}</span>
                </div>
            )}
        </div>
    );
}
