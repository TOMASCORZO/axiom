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

// ── Scene Inspection Protocol (Sprint 0) ──────────────────────────
// Wire types for the bidirectional bridge between React and the engine.
// Mirror the structures the C++ debugger captures emit.

export interface SceneNodeSnapshot {
    path: string;
    name: string;
    type: string;
    children: SceneNodeSnapshot[];
    visible: boolean;
}

export type NodePropertyType =
    | 'bool'
    | 'int'
    | 'float'
    | 'string'
    | 'vector2'
    | 'vector3'
    | 'vector4'
    | 'color'
    | 'node_path'
    | 'resource'
    | 'enum'
    | 'object';

export type NodePropertyHint =
    | 'none'
    | 'range'
    | 'file'
    | 'dir'
    | 'color_no_alpha'
    | 'enum'
    | 'multiline'
    | 'resource_type'
    | 'layers_2d'
    | 'layers_3d';

export type NodePropertyUsage = 'editor' | 'default' | 'storage' | 'category' | 'group';

export interface NodeProperty {
    name: string;
    type: NodePropertyType;
    value: unknown;
    hint?: NodePropertyHint;
    hintString?: string;
    usage?: NodePropertyUsage;
}

export interface NodeInspectorData {
    path: string;
    name: string;
    type: string;
    properties: NodeProperty[];
    script: string | null;
}

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface Transform2D {
    position: Vec2;
    rotation: number;
    scale: Vec2;
}

export interface Transform3D {
    position: Vec3;
    rotation: Vec3;
    scale: Vec3;
}

export type Transform = Transform2D | Transform3D;

export interface TransformPatch {
    position?: Vec2 | Vec3;
    rotation?: number | Vec3;
    scale?: Vec2 | Vec3;
}

export interface RaycastHit {
    path: string;
    distance: number;
    position: Vec3;
    normal?: Vec3;
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
