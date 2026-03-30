'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import EditorLayout from '@/components/editor/EditorLayout';
import { useEditorStore } from '@/lib/store';
import type { FileNode } from '@/types/project';
import { Loader2 } from 'lucide-react';

/** Convert flat file paths into a nested FileNode tree */
function buildFileTree(files: Array<{ path: string; content_type: string; size_bytes: number }>): FileNode[] {
    const root: FileNode[] = [];

    for (const file of files) {
        const parts = file.path.split('/');
        let current = root;

        for (let i = 0; i < parts.length; i++) {
            const name = parts[i];
            const pathSoFar = parts.slice(0, i + 1).join('/');
            const isFile = i === parts.length - 1;

            const existing = current.find((n) => n.name === name);

            if (existing) {
                if (existing.type === 'directory' && existing.children) {
                    current = existing.children;
                }
            } else if (isFile) {
                const ext = name.split('.').pop()?.toLowerCase();
                let fileType: FileNode['fileType'] = undefined;
                if (ext === 'scene') fileType = 'scene';
                else if (ext === 'axs') fileType = 'script';
                else if (['png', 'jpg', 'webp', 'svg', 'ogg', 'wav', 'glb'].includes(ext ?? '')) fileType = 'asset';
                else if (['project', 'cfg', 'ini'].includes(ext ?? '')) fileType = 'config';
                else if (ext === 'res') fileType = 'resource';

                current.push({
                    path: pathSoFar,
                    name,
                    type: 'file',
                    fileType,
                    size: file.size_bytes,
                });
            } else {
                const dir: FileNode = {
                    path: pathSoFar,
                    name,
                    type: 'directory',
                    size: 0,
                    children: [],
                };
                current.push(dir);
                current = dir.children!;
            }
        }
    }

    return root;
}

export default function EditorPage() {
    const params = useParams();
    const router = useRouter();
    const projectId = params.projectId as string;
    const { setProject, setFiles, setFileTree, addConsoleEntry, loadAssets } = useEditorStore();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!projectId) return;

        let cancelled = false;

        async function loadProject() {
            try {
                // Fetch project
                const projRes = await fetch(`/api/projects/${projectId}`);
                if (projRes.status === 401) {
                    router.push('/login');
                    return;
                }
                if (!projRes.ok) {
                    setError('Project not found');
                    return;
                }
                const projData = await projRes.json();
                if (cancelled) return;

                setProject(projData.project);

                // Fetch files
                const filesRes = await fetch(`/api/projects/${projectId}/files`);
                if (filesRes.ok) {
                    const filesData = await filesRes.json();
                    if (cancelled) return;

                    setFiles(filesData.files ?? []);
                    const tree = buildFileTree(filesData.files ?? []);
                    setFileTree(tree);
                }

                // Load assets from DB
                loadAssets(projectId);

                // Add welcome console entry
                addConsoleEntry({
                    id: crypto.randomUUID(),
                    level: 'log',
                    message: `[Axiom] Project loaded: ${projData.project.name}`,
                    timestamp: new Date().toISOString(),
                });
                addConsoleEntry({
                    id: crypto.randomUUID(),
                    level: 'log',
                    message: '[Axiom] Engine ready — v1.0.0',
                    timestamp: new Date().toISOString(),
                });
            } catch {
                if (!cancelled) setError('Failed to load project');
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        loadProject();
        return () => { cancelled = true; };
    }, [projectId, router, setProject, setFiles, setFileTree, addConsoleEntry, loadAssets]);

    if (loading) {
        return (
            <div className="h-screen w-screen bg-zinc-950 flex items-center justify-center">
                <div className="flex flex-col items-center gap-4 animate-fade-in">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center">
                        <span className="text-white text-xl font-black">A</span>
                    </div>
                    <Loader2 size={20} className="text-violet-400 animate-spin" />
                    <span className="text-sm text-zinc-500">Loading project...</span>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="h-screen w-screen bg-zinc-950 flex items-center justify-center">
                <div className="text-center animate-fade-in">
                    <p className="text-red-400 mb-4">{error}</p>
                    <button
                        onClick={() => router.push('/dashboard')}
                        className="text-sm text-violet-400 hover:text-violet-300 transition-colors"
                    >
                        ← Back to Dashboard
                    </button>
                </div>
            </div>
        );
    }

    return <EditorLayout projectId={projectId} />;
}
