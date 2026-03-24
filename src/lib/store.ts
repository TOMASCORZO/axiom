import { create } from 'zustand';
import type { Project, ProjectFile, FileNode } from '@/types/project';
import type { ChatMessage, ToolCallDisplay } from '@/types/agent';
import type { ConsoleEntry, EngineLoadProgress } from '@/types/engine';

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

    // Console
    consoleEntries: ConsoleEntry[];

    // UI
    leftPanelWidth: number;
    rightPanelWidth: number;
    bottomPanelHeight: number;
    activeBottomTab: 'console' | 'build' | 'errors';

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
    addMessage: (message: ChatMessage) => void;
    updateLastMessage: (content: string) => void;
    setAgentBusy: (busy: boolean) => void;
    addToolCall: (toolCall: ToolCallDisplay) => void;
    updateToolCall: (id: string, update: Partial<ToolCallDisplay>) => void;
    addConsoleEntry: (entry: ConsoleEntry) => void;
    clearConsole: () => void;
    setPanelWidth: (panel: 'left' | 'right', width: number) => void;
    setBottomPanelHeight: (height: number) => void;
    setActiveBottomTab: (tab: 'console' | 'build' | 'errors') => void;
    refreshProjectFiles: (projectId: string) => Promise<void>;
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
    consoleEntries: [],
    leftPanelWidth: 220,
    rightPanelWidth: 340,
    bottomPanelHeight: 150,
    activeBottomTab: 'console',

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

    addMessage: (message) =>
        set((state) => ({ messages: [...state.messages, message] })),

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

    refreshProjectFiles: async (projectId: string) => {
        try {
            const res = await fetch(`/api/projects/${projectId}/files`);
            if (!res.ok) return;
            const data = await res.json();
            const files = data.files ?? [];
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
}));
