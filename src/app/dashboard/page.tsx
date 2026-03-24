'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type { Project } from '@/types/project';
import {
    Plus,
    Trash2,
    Loader2,
    Gamepad2,
    LogOut,
    FolderOpen,
    Sparkles,
    X,
} from 'lucide-react';

export default function DashboardPage() {
    const router = useRouter();
    const [projects, setProjects] = useState<Project[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [newProjectName, setNewProjectName] = useState('');
    const [newProjectDesc, setNewProjectDesc] = useState('');
    const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
    const [userName, setUserName] = useState('User');

    const fetchProjects = useCallback(async () => {
        try {
            const res = await fetch('/api/projects');
            if (res.status === 401) {
                router.push('/login');
                return;
            }
            const data = await res.json();
            setProjects(data.projects ?? []);
        } catch {
            // silent fail
        } finally {
            setLoading(false);
        }
    }, [router]);

    useEffect(() => {
        fetchProjects();

        // Get user info
        const supabase = createClient();
        supabase.auth.getUser().then(({ data: { user } }) => {
            if (user) {
                setUserName(
                    user.user_metadata?.display_name ||
                    user.email?.split('@')[0] ||
                    'User'
                );
            }
        });
    }, [fetchProjects]);

    const handleCreate = async () => {
        if (!newProjectName.trim()) return;
        setCreating(true);

        try {
            const res = await fetch('/api/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newProjectName.trim(),
                    description: newProjectDesc.trim(),
                }),
            });

            if (res.ok) {
                const data = await res.json();
                setProjects((prev) => [data.project, ...prev]);
                setShowCreateModal(false);
                setNewProjectName('');
                setNewProjectDesc('');
            }
        } catch {
            // silent fail
        } finally {
            setCreating(false);
        }
    };

    const handleDelete = async (id: string) => {
        try {
            const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
            if (res.ok) {
                setProjects((prev) => prev.filter((p) => p.id !== id));
                setDeleteConfirm(null);
            }
        } catch {
            // silent fail
        }
    };

    const handleLogout = async () => {
        const supabase = createClient();
        await supabase.auth.signOut();
        router.push('/');
        router.refresh();
    };

    return (
        <div className="min-h-screen bg-zinc-950 text-white">
            {/* Background */}
            <div className="fixed inset-0 pointer-events-none">
                <div className="absolute top-0 right-1/4 w-[500px] h-[400px] bg-violet-500/5 blur-[120px] rounded-full" />
                <div className="absolute bottom-0 left-1/4 w-[400px] h-[300px] bg-fuchsia-500/5 blur-[100px] rounded-full" />
            </div>

            {/* Navbar */}
            <nav className="relative z-10 border-b border-white/5 bg-zinc-950/80 backdrop-blur-xl">
                <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center">
                            <span className="text-white text-sm font-black">A</span>
                        </div>
                        <span className="text-lg font-bold bg-gradient-to-r from-violet-300 to-fuchsia-300 bg-clip-text text-transparent">
                            Axiom
                        </span>
                    </div>
                    <div className="flex items-center gap-4">
                        <span className="text-sm text-zinc-400">
                            {userName}
                        </span>
                        <button
                            onClick={handleLogout}
                            className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
                        >
                            <LogOut size={14} />
                            Sign out
                        </button>
                    </div>
                </div>
            </nav>

            {/* Content */}
            <main className="relative z-10 max-w-6xl mx-auto px-6 py-12">
                <div className="flex items-center justify-between mb-8">
                    <div>
                        <h1 className="text-2xl font-bold">Your Projects</h1>
                        <p className="text-sm text-zinc-500 mt-1">{projects.length} project{projects.length !== 1 ? 's' : ''}</p>
                    </div>
                    <button
                        onClick={() => setShowCreateModal(true)}
                        className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 rounded-xl text-sm font-semibold transition-all shadow-lg shadow-violet-500/20"
                    >
                        <Plus size={16} />
                        New Project
                    </button>
                </div>

                {/* Loading */}
                {loading && (
                    <div className="flex items-center justify-center py-24">
                        <Loader2 size={24} className="text-violet-400 animate-spin" />
                    </div>
                )}

                {/* Empty state */}
                {!loading && projects.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-24 animate-fade-in">
                        <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-violet-500/10 to-fuchsia-500/10 flex items-center justify-center mb-6">
                            <Sparkles size={36} className="text-violet-400/60" />
                        </div>
                        <h2 className="text-lg font-semibold mb-2">No projects yet</h2>
                        <p className="text-sm text-zinc-500 mb-6 text-center max-w-sm">
                            Create your first project and start building games with AI.
                        </p>
                        <button
                            onClick={() => setShowCreateModal(true)}
                            className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 rounded-xl text-sm font-semibold transition-all"
                        >
                            <Plus size={16} />
                            Create First Project
                        </button>
                    </div>
                )}

                {/* Project Grid */}
                {!loading && projects.length > 0 && (
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 animate-fade-in">
                        {projects.map((project) => (
                            <div
                                key={project.id}
                                className="group relative bg-zinc-900/50 border border-white/5 rounded-2xl p-5 hover:border-violet-500/30 hover:shadow-lg hover:shadow-violet-500/5 transition-all cursor-pointer"
                                onClick={() => router.push(`/editor/${project.id}`)}
                            >
                                {/* Thumbnail / icon */}
                                <div className="w-full h-32 bg-zinc-800/50 rounded-xl mb-4 flex items-center justify-center overflow-hidden">
                                    {project.thumbnail_url ? (
                                        <img
                                            src={project.thumbnail_url}
                                            alt={project.name}
                                            className="w-full h-full object-cover"
                                        />
                                    ) : (
                                        <Gamepad2 size={32} className="text-zinc-600" />
                                    )}
                                </div>

                                <h3 className="font-semibold text-white mb-1 truncate">{project.name}</h3>
                                <p className="text-xs text-zinc-500 line-clamp-2 mb-3">
                                    {project.description || 'No description'}
                                </p>

                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-zinc-600">
                                        {new Date(project.updated_at).toLocaleDateString()}
                                    </span>
                                    <div className="flex items-center gap-1">
                                        <button
                                            onClick={(e) => { e.stopPropagation(); router.push(`/editor/${project.id}`); }}
                                            className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-500 hover:text-white transition-colors"
                                            title="Open in editor"
                                        >
                                            <FolderOpen size={14} />
                                        </button>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setDeleteConfirm(project.id); }}
                                            className="p-1.5 rounded-lg hover:bg-red-500/10 text-zinc-500 hover:text-red-400 transition-colors"
                                            title="Delete project"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                </div>

                                {/* Delete confirmation */}
                                {deleteConfirm === project.id && (
                                    <div
                                        className="absolute inset-0 bg-zinc-900/95 rounded-2xl flex flex-col items-center justify-center p-6 z-10 backdrop-blur-sm animate-fade-in"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <p className="text-sm text-zinc-300 mb-4 text-center">
                                            Delete <strong>{project.name}</strong>? This cannot be undone.
                                        </p>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => setDeleteConfirm(null)}
                                                className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm transition-colors"
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                onClick={() => handleDelete(project.id)}
                                                className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 rounded-lg text-sm text-red-300 transition-colors"
                                            >
                                                Delete
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </main>

            {/* Create Modal */}
            {showCreateModal && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-zinc-900 border border-white/10 rounded-2xl p-6 w-full max-w-md animate-slide-up">
                        <div className="flex items-center justify-between mb-5">
                            <h2 className="text-lg font-bold">New Project</h2>
                            <button
                                onClick={() => setShowCreateModal(false)}
                                className="p-1 hover:bg-white/10 rounded-lg transition-colors"
                            >
                                <X size={16} className="text-zinc-400" />
                            </button>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="text-xs font-medium text-zinc-400 mb-1.5 block">Project Name</label>
                                <input
                                    type="text"
                                    value={newProjectName}
                                    onChange={(e) => setNewProjectName(e.target.value)}
                                    placeholder="My Awesome Game"
                                    autoFocus
                                    className="w-full px-4 py-2.5 bg-zinc-800/50 border border-white/10 rounded-xl text-sm text-white placeholder-zinc-500 focus:border-violet-500/50 focus:outline-none transition-colors"
                                    onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                                />
                            </div>

                            <div>
                                <label className="text-xs font-medium text-zinc-400 mb-1.5 block">Description (optional)</label>
                                <textarea
                                    value={newProjectDesc}
                                    onChange={(e) => setNewProjectDesc(e.target.value)}
                                    placeholder="A brief description of your game..."
                                    rows={3}
                                    className="w-full px-4 py-2.5 bg-zinc-800/50 border border-white/10 rounded-xl text-sm text-white placeholder-zinc-500 focus:border-violet-500/50 focus:outline-none transition-colors resize-none"
                                />
                            </div>

                            <div className="flex gap-3 pt-2">
                                <button
                                    onClick={() => setShowCreateModal(false)}
                                    className="flex-1 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-sm font-medium transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleCreate}
                                    disabled={!newProjectName.trim() || creating}
                                    className="flex-1 py-2.5 bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 disabled:opacity-50 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2"
                                >
                                    {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                                    Create
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
