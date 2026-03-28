'use client';

import { useMemo, useState } from 'react';
import { useEditorStore } from '@/lib/store';
import { X, Code, Gamepad2, Settings, Image, File, ZoomIn, ZoomOut, Download } from 'lucide-react';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif', 'bmp', 'ico']);

function getImageUrl(storageKey: string): string {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    return `${supabaseUrl}/storage/v1/object/public/assets/${storageKey}`;
}

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

function ImagePreview({ src, fileName, sizeBytes }: { src: string; fileName: string; sizeBytes: number }) {
    const [zoom, setZoom] = useState(1);
    const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);

    const sizeLabel = sizeBytes > 1024 * 1024
        ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.round(sizeBytes / 1024)} KB`;

    return (
        <div className="flex flex-col h-full">
            {/* Toolbar */}
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5 bg-zinc-900/30">
                <button
                    onClick={() => setZoom(z => Math.max(0.25, z / 1.5))}
                    className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                    title="Zoom out"
                >
                    <ZoomOut size={13} />
                </button>
                <span className="text-[10px] text-zinc-500 min-w-[40px] text-center">{Math.round(zoom * 100)}%</span>
                <button
                    onClick={() => setZoom(z => Math.min(8, z * 1.5))}
                    className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                    title="Zoom in"
                >
                    <ZoomIn size={13} />
                </button>
                <button
                    onClick={() => setZoom(1)}
                    className="px-1.5 py-0.5 rounded text-[10px] text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                >
                    1:1
                </button>
                <button
                    onClick={() => setZoom(0)} // 0 = fit
                    className="px-1.5 py-0.5 rounded text-[10px] text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                >
                    Fit
                </button>
                <div className="flex-1" />
                {imgSize && (
                    <span className="text-[10px] text-zinc-600">{imgSize.w} x {imgSize.h}px</span>
                )}
                <span className="text-[10px] text-zinc-600">{sizeLabel}</span>
                <a
                    href={src}
                    download={fileName}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                    title="Download"
                >
                    <Download size={13} />
                </a>
            </div>

            {/* Image area with checkerboard */}
            <div className="flex-1 overflow-auto flex items-center justify-center p-4 bg-zinc-950">
                {/* Checkerboard background behind image */}
                <div className="relative inline-block">
                    <div className="absolute inset-0 rounded bg-[length:12px_12px] bg-[position:0_0,6px_6px] bg-[image:linear-gradient(45deg,#1a1a2e_25%,transparent_25%,transparent_75%,#1a1a2e_75%),linear-gradient(45deg,#1a1a2e_25%,transparent_25%,transparent_75%,#1a1a2e_75%)]" />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={src}
                        alt={fileName}
                        className="relative block"
                        style={zoom === 0
                            ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }
                            : { width: imgSize ? imgSize.w * zoom : 'auto', imageRendering: zoom >= 2 ? 'pixelated' : 'auto' }
                        }
                        onLoad={(e) => {
                            const img = e.currentTarget;
                            setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
                        }}
                        draggable={false}
                    />
                </div>
            </div>
        </div>
    );
}

export default function CodeEditor() {
    const { activeFile, openFiles, files, setActiveFile, closeFile } = useEditorStore();

    const activeFileData = useMemo(() => {
        if (!activeFile) return null;
        return files.find(f => f.path === activeFile) ?? null;
    }, [activeFile, files]);

    const ext = activeFile?.split('.').pop()?.toLowerCase() ?? '';
    const isImage = IMAGE_EXTENSIONS.has(ext);

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

            {/* Content */}
            <div className="flex-1 overflow-auto scrollbar-thin scrollbar-thumb-zinc-800">
                {isImage && activeFileData?.storage_key ? (
                    <ImagePreview
                        src={getImageUrl(activeFileData.storage_key)}
                        fileName={activeFile?.split('/').pop() ?? 'image'}
                        sizeBytes={activeFileData.size_bytes}
                    />
                ) : activeFileData ? (
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

            {/* Status bar (text files only) */}
            {activeFileData && !isImage && (
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
