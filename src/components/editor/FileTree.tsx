'use client';

import { useState } from 'react';
import { useEditorStore } from '@/lib/store';
import type { FileNode } from '@/types/project';
import { MAP_ASSET_DRAG_MIME } from './MapCanvas';
import {
    ChevronRight,
    ChevronDown,
    File,
    Folder,
    FolderOpen,
    Gamepad2,
    Image,
    Code,
    Settings,
    Plus,
    FilePlus,
} from 'lucide-react';

function getFileIcon(name: string) {
    const ext = name.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'axs': return <Code size={14} className="text-emerald-400" />;
        case 'scene': return <Gamepad2 size={14} className="text-violet-400" />;
        case 'res': return <Settings size={14} className="text-amber-400" />;
        case 'png': case 'jpg': case 'webp': case 'svg':
            return <Image size={14} className="text-sky-400" />;
        default: return <File size={14} className="text-zinc-400" />;
    }
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);

function FileTreeNode({ node, depth = 0 }: { node: FileNode; depth?: number }) {
    const [expanded, setExpanded] = useState(depth < 2);
    const { activeFile, openFile, activeRightPanel, assets, project, files, previewAssetId, setPreviewAssetId, addAsset } = useEditorStore();
    const isActive = activeFile === node.path;

    if (node.type === 'directory') {
        return (
            <div>
                <button
                    onClick={() => setExpanded(!expanded)}
                    className={`
            flex items-center w-full px-2 py-1 text-sm gap-1.5
            hover:bg-white/5 transition-colors rounded-md
            text-zinc-300 hover:text-white
          `}
                    style={{ paddingLeft: `${depth * 12 + 8}px` }}
                >
                    {expanded ? (
                        <ChevronDown size={12} className="text-zinc-500" />
                    ) : (
                        <ChevronRight size={12} className="text-zinc-500" />
                    )}
                    {expanded ? (
                        <FolderOpen size={14} className="text-amber-400/80" />
                    ) : (
                        <Folder size={14} className="text-amber-400/60" />
                    )}
                    <span className="truncate">{node.name}</span>
                </button>
                {expanded && node.children?.map((child) => (
                    <FileTreeNode key={child.path} node={child} depth={depth + 1} />
                ))}
            </div>
        );
    }

    const ext = node.name.split('.').pop()?.toLowerCase() ?? '';
    const isImage = IMAGE_EXTS.has(ext);
    const isAssetMode = activeRightPanel === 'assets';

    const handleClick = () => {
        if (isAssetMode && isImage) {
            // In Asset Studio mode, clicking an image should preview it
            const existing = assets.find(a =>
                a.storage_key === node.path ||
                a.storage_key.endsWith('/' + node.path) ||
                a.name === node.name
            );
            if (existing) {
                setPreviewAssetId(existing.id);
            } else {
                // Look up the full storage_key from project_files
                const pf = files.find(f => f.path === node.path);
                const storageKey = pf?.storage_key || node.path;
                const assetId = crypto.randomUUID();
                addAsset({
                    id: assetId,
                    project_id: project?.id ?? '',
                    name: node.name,
                    asset_type: 'sprite',
                    storage_key: storageKey,
                    thumbnail_key: null,
                    file_format: ext,
                    width: null,
                    height: null,
                    metadata: { tags: ['file-tree'] },
                    generation_prompt: null,
                    generation_model: null,
                    size_bytes: pf?.size_bytes ?? node.size ?? 0,
                    created_at: new Date().toISOString(),
                });
                setPreviewAssetId(assetId);
            }
        } else {
            openFile(node.path);
        }
    };

    const isPreviewed = isAssetMode && isImage && assets.some(a => a.id === previewAssetId && a.storage_key.endsWith(node.path));

    // Find the asset record for this file (if any) so we know whether to allow
    // dragging onto the Map canvas. Maps can't be placed onto maps, so we skip
    // drag for asset_type === 'map'.
    const matchedAsset = isImage
        ? assets.find(a =>
            a.storage_key === node.path ||
            a.storage_key.endsWith('/' + node.path) ||
            a.name === node.name,
        )
        : undefined;
    const canDrag = isImage && (!matchedAsset || matchedAsset.asset_type !== 'map');

    const handleDragStart = (e: React.DragEvent<HTMLButtonElement>) => {
        if (!canDrag) return;
        let assetId = matchedAsset?.id;
        if (!assetId) {
            // Register the file as an asset on the fly (mirrors handleClick).
            const pf = files.find(f => f.path === node.path);
            const storageKey = pf?.storage_key || node.path;
            assetId = crypto.randomUUID();
            addAsset({
                id: assetId,
                project_id: project?.id ?? '',
                name: node.name,
                asset_type: 'sprite',
                storage_key: storageKey,
                thumbnail_key: null,
                file_format: ext,
                width: null,
                height: null,
                metadata: { tags: ['file-tree'] },
                generation_prompt: null,
                generation_model: null,
                size_bytes: pf?.size_bytes ?? node.size ?? 0,
                created_at: new Date().toISOString(),
            });
        }
        e.dataTransfer.setData(MAP_ASSET_DRAG_MIME, assetId);
        e.dataTransfer.effectAllowed = 'copy';
    };

    return (
        <button
            onClick={handleClick}
            draggable={canDrag}
            onDragStart={canDrag ? handleDragStart : undefined}
            className={`
        flex items-center w-full px-2 py-1 text-sm gap-1.5
        transition-colors rounded-md truncate
        ${isPreviewed
                    ? 'bg-violet-500/20 text-violet-200 border-l-2 border-violet-500'
                    : isActive && !isAssetMode
                    ? 'bg-violet-500/20 text-violet-200 border-l-2 border-violet-500'
                    : 'hover:bg-white/5 text-zinc-400 hover:text-zinc-200'
                }
      `}
            style={{ paddingLeft: `${depth * 12 + 20}px` }}
        >
            {getFileIcon(node.name)}
            <span className="truncate">{node.name}</span>
        </button>
    );
}

interface FileTreeProps {
    projectId: string;
}

export default function FileTree({ projectId }: FileTreeProps) {
    const { fileTree } = useEditorStore();
    const [showNewFile, setShowNewFile] = useState(false);
    const [newFileName, setNewFileName] = useState('');

    const handleCreateFile = async () => {
        if (!newFileName.trim()) return;

        try {
            await fetch(`/api/projects/${projectId}/files`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: newFileName.trim(),
                    content: '',
                    content_type: 'text',
                }),
            });
            setNewFileName('');
            setShowNewFile(false);
            // Reload files (in a full app this would update the store)
            window.location.reload();
        } catch {
            // silent fail
        }
    };

    return (
        <div className="h-full flex flex-col bg-zinc-950/50">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/5">
                <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                    Files
                </span>
                <button
                    onClick={() => setShowNewFile(!showNewFile)}
                    className="p-1 hover:bg-white/10 rounded transition-colors"
                    title="New file"
                >
                    <Plus size={14} className="text-zinc-400" />
                </button>
            </div>

            {/* New file input */}
            {showNewFile && (
                <div className="px-2 py-2 border-b border-white/5 animate-fade-in">
                    <div className="flex items-center gap-1.5">
                        <FilePlus size={12} className="text-zinc-500 flex-shrink-0" />
                        <input
                            type="text"
                            value={newFileName}
                            onChange={(e) => setNewFileName(e.target.value)}
                            placeholder="path/to/file.axs"
                            autoFocus
                            className="flex-1 bg-zinc-800/50 border border-white/10 rounded px-2 py-1 text-xs text-white placeholder-zinc-600 focus:border-violet-500/50 focus:outline-none"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') handleCreateFile();
                                if (e.key === 'Escape') setShowNewFile(false);
                            }}
                        />
                    </div>
                </div>
            )}

            {/* Tree */}
            <div className="flex-1 overflow-y-auto py-1 px-1 scrollbar-thin scrollbar-thumb-zinc-800">
                {fileTree.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center px-4">
                        <Folder size={24} className="text-zinc-700 mb-2" />
                        <p className="text-xs text-zinc-600">No files yet</p>
                        <button
                            onClick={() => setShowNewFile(true)}
                            className="text-xs text-violet-400 hover:text-violet-300 mt-1 transition-colors"
                        >
                            Create a file
                        </button>
                    </div>
                ) : (
                    fileTree.map((node) => (
                        <FileTreeNode key={node.path} node={node} />
                    ))
                )}
            </div>
        </div>
    );
}
