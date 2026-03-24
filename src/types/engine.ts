// ── Engine WASM Integration Types ──────────────────────────────────

export interface AxiomEngineConfig {
    canvas: HTMLCanvasElement;
    projectZipUrl: string;
    locale: string;
    args: string[];
    onProgress: (percent: number) => void;
    onReady: () => void;
    onError: (err: string) => void;
    onConsole: (level: ConsoleLevel, message: string) => void;
}

export type ConsoleLevel = 'log' | 'warn' | 'error' | 'debug';

export interface AxiomEngineInstance {
    start: () => Promise<void>;
    stop: () => void;
    reloadScene: () => void;
    updateFile: (path: string, content: ArrayBuffer | string) => void;
    deleteFile: (path: string) => void;
    getScreenshot: () => string; // base64 data URL
    isRunning: boolean;
}

export interface EngineLoadProgress {
    stage: 'downloading' | 'compiling' | 'initializing' | 'loading_project' | 'ready';
    percent: number;
    message: string;
}

// ── Console Entry ──────────────────────────────────────────────────

export interface ConsoleEntry {
    id: string;
    level: ConsoleLevel;
    message: string;
    source?: string;
    line?: number;
    timestamp: string;
}

// ── Build Types ────────────────────────────────────────────────────

export type BuildPlatform = 'web' | 'windows' | 'linux' | 'macos' | 'android';
export type BuildStatus = 'queued' | 'building' | 'completed' | 'failed';

export interface Build {
    id: string;
    project_id: string;
    platform: BuildPlatform;
    status: BuildStatus;
    build_url: string | null;
    log: string;
    version_id: string | null;
    started_at: string | null;
    completed_at: string | null;
    created_at: string;
}
