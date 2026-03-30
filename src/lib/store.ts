import { create } from 'zustand';
import type { Project, ProjectFile, FileNode } from '@/types/project';
import type { ChatMessage, ToolCallDisplay, ConversationSummary } from '@/types/agent';
import type { ConsoleEntry, EngineLoadProgress } from '@/types/engine';
import type { Asset } from '@/types/asset';

// ── Editor Store ───────────────────────────────────────────────────

interface EditorState {
    // Project
    project: Project | null;
    files: ProjectFile[];
    fileTree: FileNode[];
    activeFile: string | null;
    openFiles: string[];

    // Engine
    engineStatus: EngineLoadProgress['stage'] | 'idle' | 'error';
    engineProgress: number;
    isPlaying: boolean;

    // Chat
    messages: ChatMessage[];
    isAgentBusy: boolean;
    activeToolCalls: ToolCallDisplay[];
    conversations: ConversationSummary[];
    activeConversationId: string | null;
    isLoadingConversations: boolean;
    chatView: 'chat' | 'history';

    // Console
    consoleEntries: ConsoleEntry[];

    // UI
    leftPanelWidth: number;
    rightPanelWidth: number;
    bottomPanelHeight: number;
    activeBottomTab: 'console' | 'build' | 'errors';
    activeRightPanel: 'chat' | 'assets';

    // Asset Studio
    assets: Asset[];
    assetGenerating: boolean;
    assetStudioTab: 'generate' | 'gallery';
    previewAssetId: string | null;

    // Animation playback (shared between AssetPreview and AnimationTimeline)
    animCurrentFrame: number;
    animIsPlaying: boolean;
    animFps: number;

    // Actions
    setProject: (project: Project) => void;
    setFiles: (files: ProjectFile[]) => void;
    setFileTree: (tree: FileNode[]) => void;
    setActiveFile: (path: string | null) => void;
    openFile: (path: string) => void;
    closeFile: (path: string) => void;
    setEngineStatus: (status: EngineLoadProgress['stage'] | 'idle' | 'error') => void;
    setEngineProgress: (percent: number) => void;
    setIsPlaying: (playing: boolean) => void;
    setMessages: (messages: ChatMessage[]) => void;
    addMessage: (message: ChatMessage) => void;
    updateMessage: (id: string, update: Partial<ChatMessage>) => void;
    updateLastMessage: (content: string) => void;
    setAgentBusy: (busy: boolean) => void;
    addToolCall: (toolCall: ToolCallDisplay) => void;
    updateToolCall: (id: string, update: Partial<ToolCallDisplay>) => void;
    addConsoleEntry: (entry: ConsoleEntry) => void;
    clearConsole: () => void;
    setPanelWidth: (panel: 'left' | 'right', width: number) => void;
    setBottomPanelHeight: (height: number) => void;
    setActiveBottomTab: (tab: 'console' | 'build' | 'errors') => void;
    setActiveRightPanel: (panel: 'chat' | 'assets') => void;
    setAssets: (assets: Asset[]) => void;
    addAsset: (asset: Asset) => void;
    removeAsset: (id: string) => void;
    loadAssets: (projectId: string) => Promise<void>;
    setAssetGenerating: (generating: boolean) => void;
    setAssetStudioTab: (tab: 'generate' | 'gallery') => void;
    setPreviewAssetId: (id: string | null) => void;
    setAnimCurrentFrame: (frame: number) => void;
    setAnimIsPlaying: (playing: boolean) => void;
    setAnimFps: (fps: number) => void;
    refreshProjectFiles: (projectId: string) => Promise<void>;
    addProjectFiles: (newFiles: Array<{ path: string; content: string; size_bytes: number; content_type: string }>) => void;
    setChatView: (view: 'chat' | 'history') => void;
    setConversations: (conversations: ConversationSummary[]) => void;
    setActiveConversationId: (id: string | null) => void;
    setIsLoadingConversations: (loading: boolean) => void;
    loadConversations: (projectId: string) => Promise<void>;
    switchConversation: (conversationId: string, projectId: string) => Promise<void>;
    newConversation: () => void;
}

export const useEditorStore = create<EditorState>((set) => ({
    // Initial state
    project: null,
    files: [],
    fileTree: [],
    activeFile: null,
    openFiles: [],
    engineStatus: 'idle',
    engineProgress: 0,
    isPlaying: false,
    messages: [],
    isAgentBusy: false,
    activeToolCalls: [],
    conversations: [],
    activeConversationId: null,
    isLoadingConversations: false,
    chatView: 'chat',
    consoleEntries: [],
    leftPanelWidth: 220,
    rightPanelWidth: 340,
    bottomPanelHeight: 150,
    activeBottomTab: 'console',
    activeRightPanel: 'chat',
    assets: [],
    assetGenerating: false,
    assetStudioTab: 'generate',
    previewAssetId: null,
    animCurrentFrame: 0,
    animIsPlaying: false,
    animFps: 12,

    // Actions
    setProject: (project) => set({ project }),
    setFiles: (files) => set({ files }),
    setFileTree: (tree) => set({ fileTree: tree }),
    setActiveFile: (path) => set({ activeFile: path }),

    openFile: (path) =>
        set((state) => ({
            openFiles: state.openFiles.includes(path)
                ? state.openFiles
                : [...state.openFiles, path],
            activeFile: path,
        })),

    closeFile: (path) =>
        set((state) => {
            const newOpenFiles = state.openFiles.filter((f) => f !== path);
            return {
                openFiles: newOpenFiles,
                activeFile:
                    state.activeFile === path
                        ? newOpenFiles[newOpenFiles.length - 1] ?? null
                        : state.activeFile,
            };
        }),

    setEngineStatus: (status) => set({ engineStatus: status }),
    setEngineProgress: (percent) => set({ engineProgress: percent }),
    setIsPlaying: (playing) => set({ isPlaying: playing }),

    setMessages: (messages) => set({ messages }),

    addMessage: (message) =>
        set((state) => ({ messages: [...state.messages, message] })),

    updateMessage: (id, update) =>
        set((state) => ({
            messages: state.messages.map((m) =>
                m.id === id ? { ...m, ...update } : m,
            ),
        })),

    updateLastMessage: (content) =>
        set((state) => {
            const messages = [...state.messages];
            if (messages.length > 0) {
                messages[messages.length - 1] = {
                    ...messages[messages.length - 1],
                    content,
                };
            }
            return { messages };
        }),

    setAgentBusy: (busy) => set({ isAgentBusy: busy }),

    addToolCall: (toolCall) =>
        set((state) => ({
            activeToolCalls: [...state.activeToolCalls, toolCall],
        })),

    updateToolCall: (id, update) =>
        set((state) => ({
            activeToolCalls: state.activeToolCalls.map((tc) =>
                tc.id === id ? { ...tc, ...update } : tc,
            ),
        })),

    addConsoleEntry: (entry) =>
        set((state) => ({
            consoleEntries: [...state.consoleEntries.slice(-500), entry],
        })),

    clearConsole: () => set({ consoleEntries: [] }),

    setPanelWidth: (panel, width) =>
        set(panel === 'left' ? { leftPanelWidth: width } : { rightPanelWidth: width }),

    setBottomPanelHeight: (height) => set({ bottomPanelHeight: height }),
    setActiveBottomTab: (tab) => set({ activeBottomTab: tab }),
    setActiveRightPanel: (panel) => set({ activeRightPanel: panel }),
    setAssets: (assets) => set({ assets }),
    addAsset: (asset) => {
        set((state) => ({ assets: [...state.assets, asset] }));
        // Persist to Supabase in background
        fetch('/api/assets/db', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(asset),
        }).catch(() => {});
    },
    removeAsset: (id) => {
        set((state) => ({
            assets: state.assets.filter(a => a.id !== id),
            previewAssetId: state.previewAssetId === id ? null : state.previewAssetId,
        }));
        // Delete from Supabase in background
        fetch(`/api/assets/db?id=${id}`, { method: 'DELETE' }).catch(() => {});
    },
    loadAssets: async (projectId: string) => {
        try {
            const res = await fetch(`/api/assets/db?project_id=${projectId}`);
            if (res.ok) {
                const data = await res.json();
                set({ assets: data.assets ?? [] });
            }
        } catch { /* silent */ }
    },
    setAssetGenerating: (generating) => set({ assetGenerating: generating }),
    setAssetStudioTab: (tab) => set({ assetStudioTab: tab }),
    setPreviewAssetId: (id) => set({ previewAssetId: id, animCurrentFrame: 0, animIsPlaying: false }),
    setAnimCurrentFrame: (frame) => set({ animCurrentFrame: frame }),
    setAnimIsPlaying: (playing) => set({ animIsPlaying: playing }),
    setAnimFps: (fps) => set({ animFps: fps }),

    setChatView: (view) => set({ chatView: view }),
    setConversations: (conversations) => set({ conversations }),
    setActiveConversationId: (id) => set({ activeConversationId: id }),
    setIsLoadingConversations: (loading) => set({ isLoadingConversations: loading }),

    loadConversations: async (projectId: string) => {
        set({ isLoadingConversations: true });
        try {
            const res = await fetch(`/api/projects/${projectId}/conversations`);
            if (res.ok) {
                const data = await res.json();
                set({ conversations: data.conversations ?? [] });
            }
        } catch {
            // Silent fail
        } finally {
            set({ isLoadingConversations: false });
        }
    },

    switchConversation: async (conversationId: string, projectId: string) => {
        set({ activeConversationId: conversationId, chatView: 'chat', messages: [], isAgentBusy: false });
        try {
            const res = await fetch(`/api/projects/${projectId}/conversations/${conversationId}`);
            if (!res.ok) return;
            const data = await res.json();
            const messages: ChatMessage[] = (data.messages ?? [])
                .filter((m: any) => m.role === 'user' || m.role === 'assistant')
                .map((m: any) => ({
                    id: m.id,
                    role: m.role as 'user' | 'assistant',
                    content: m.content,
                    timestamp: m.created_at,
                }));
            set({ messages });
        } catch {
            // Silent fail
        }
    },

    newConversation: () => set({
        activeConversationId: null,
        messages: [],
        chatView: 'chat',
        isAgentBusy: false,
    }),

    refreshProjectFiles: async (projectId: string) => {
        try {
            const res = await fetch(`/api/projects/${projectId}/files`);
            if (!res.ok) {
                console.warn('[axiom] refreshProjectFiles failed:', res.status);
                return;
            }
            const data = await res.json();
            const dbFiles: ProjectFile[] = data.files ?? [];
            console.log('[axiom] refreshProjectFiles:', dbFiles.length, 'files from DB');

            // Merge: DB files win, but preserve any in-memory files not yet in DB
            const dbMap = new Map(dbFiles.map(f => [f.path, f]));
            const currentFiles = useEditorStore.getState().files;
            for (const cf of currentFiles) {
                if (!dbMap.has(cf.path) && cf.text_content != null) {
                    dbMap.set(cf.path, cf);
                }
            }
            const files = Array.from(dbMap.values());
            set({ files });

            // Rebuild file tree
            const root: FileNode[] = [];
            for (const file of files) {
                const parts = file.path.split('/');
                let current = root;
                for (let i = 0; i < parts.length; i++) {
                    const name = parts[i];
                    const pathSoFar = parts.slice(0, i + 1).join('/');
                    const isFile = i === parts.length - 1;
                    const existing = current.find((n: FileNode) => n.name === name);
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
                        else if (['axiom', 'cfg', 'ini'].includes(ext ?? '')) fileType = 'config';
                        else if (ext === 'res') fileType = 'resource';
                        current.push({ path: pathSoFar, name, type: 'file', fileType, size: file.size_bytes });
                    } else {
                        const dir: FileNode = { path: pathSoFar, name, type: 'directory', size: 0, children: [] };
                        current.push(dir);
                        current = dir.children!;
                    }
                }
            }
            set({ fileTree: root });
        } catch {
            // Silent fail on refresh
        }
    },

    addProjectFiles: (newFiles) => set((state) => {
        // Merge new files into existing files list
        const fileMap = new Map(state.files.map(f => [f.path, f]));
        for (const nf of newFiles) {
            const existing = fileMap.get(nf.path);
            const merged: ProjectFile = {
                id: existing?.id ?? crypto.randomUUID(),
                project_id: existing?.project_id ?? '',
                path: nf.path,
                content_type: (nf.content_type === 'text' || nf.content_type === 'binary') ? nf.content_type : 'text',
                text_content: nf.content,
                storage_key: existing?.storage_key ?? null,
                size_bytes: nf.size_bytes,
                checksum: null,
                created_at: existing?.created_at ?? new Date().toISOString(),
                updated_at: new Date().toISOString(),
            };
            fileMap.set(nf.path, merged);
        }

        const files = Array.from(fileMap.values());

        // Rebuild file tree
        const root: FileNode[] = [];
        for (const file of files) {
            const parts = file.path.split('/');
            let current = root;
            for (let i = 0; i < parts.length; i++) {
                const name = parts[i];
                const pathSoFar = parts.slice(0, i + 1).join('/');
                const isFile = i === parts.length - 1;
                const existing = current.find((n: FileNode) => n.name === name);
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
                    else if (['axiom', 'cfg', 'ini'].includes(ext ?? '')) fileType = 'config';
                    else if (ext === 'res') fileType = 'resource';
                    current.push({ path: pathSoFar, name, type: 'file', fileType, size: file.size_bytes });
                } else {
                    const dir: FileNode = { path: pathSoFar, name, type: 'directory', size: 0, children: [] };
                    current.push(dir);
                    current = dir.children!;
                }
            }
        }

        return { files, fileTree: root };
    }),
}));
