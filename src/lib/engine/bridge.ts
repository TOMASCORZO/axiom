/**
 * Axiom Engine — Bridge
 *
 * Communicates with the Axiom Engine running inside an iframe via postMessage.
 * This is the single interface between the React app and the WASM runtime.
 */

import type {
    GizmoMode,
    NodeInspectorData,
    RaycastHit,
    SceneNodeSnapshot,
    Transform,
    TransformPatch,
    Vec2,
    Vec3,
} from '@/types/engine';

// ── Wire types ─────────────────────────────────────────────────────

export type EngineMessage =
    | { type: 'ready' }
    | { type: 'started' }
    | { type: 'stopped'; exitCode?: number }
    | { type: 'fps'; value: number }
    | { type: 'progress'; value: number }
    | { type: 'console'; level: 'log' | 'warn' | 'error'; message: string }
    | { type: 'error'; message: string }
    | { type: 'screenshot'; dataUrl: string }
    | { type: 'files-synced' }
    // Sprint 0 — protocol responses & spontaneous events
    | { type: 'response'; requestId: string; ok: true; data: unknown }
    | { type: 'response'; requestId: string; ok: false; error: string }
    | { type: 'selection-changed'; path: string | null }
    | { type: 'scene-tree-changed' }
    | { type: 'node-transform-changed'; path: string; transform: Transform };

/** One entry in a start/sync-files payload. Binary assets (PNG, audio, glb)
 *  must be sent with `encoding: 'base64'` — the iframe decodes before writing
 *  to the WASM virtual filesystem. Text files default to 'utf8'. */
export interface FilePayload {
    path: string;
    content: string;
    encoding?: 'utf8' | 'base64';
}

export type AppCommand =
    | { type: 'start'; files: FilePayload[] }
    | { type: 'stop' }
    | { type: 'sync-files'; files: FilePayload[] }
    | { type: 'reload-scene' }
    | { type: 'screenshot' }
    // Sprint 0 — request/response (every request carries a requestId)
    | { type: 'scene-tree'; requestId: string }
    | { type: 'node-info'; requestId: string; path: string }
    | { type: 'raycast'; requestId: string; screenX: number; screenY: number }
    | { type: 'set-property'; requestId: string; path: string; property: string; value: unknown }
    | { type: 'set-transform'; requestId: string; path: string; patch: TransformPatch }
    | { type: 'add-node'; requestId: string; parentPath: string; nodeType: string; nodeName: string }
    | { type: 'delete-node'; requestId: string; path: string }
    // Fire-and-forget
    | { type: 'select-node'; path: string | null }
    | { type: 'set-gizmo-mode'; mode: GizmoMode };

type MessageHandler = (msg: EngineMessage) => void;

// Requests time out so a dropped engine response doesn't leak the promise forever.
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
}

export class AxiomEngineBridge {
    private iframe: HTMLIFrameElement | null = null;
    private handlers: MessageHandler[] = [];
    private boundListener: ((event: MessageEvent) => void) | null = null;
    private _isReady = false;
    private _isRunning = false;
    private pending = new Map<string, PendingRequest>();

    /** Whether the engine iframe has loaded and sent its 'ready' message */
    get isReady(): boolean {
        return this._isReady;
    }

    /** Whether the engine is currently running a game */
    get isRunning(): boolean {
        return this._isRunning;
    }

    /**
     * Attach to an iframe element and start listening for messages.
     */
    connect(iframe: HTMLIFrameElement): void {
        this.iframe = iframe;
        this.boundListener = this.handleMessage.bind(this);
        window.addEventListener('message', this.boundListener);

        // Send a ping — the shell will respond with 'ready' if it's already loaded.
        // This handles the case where 'ready' was sent before the bridge connected.
        try {
            iframe.contentWindow?.postMessage({ source: 'axiom-app', type: 'ping' }, '*');
        } catch { /* cross-origin or not loaded yet — shell will send ready when it loads */ }
    }

    /**
     * Detach from the iframe and stop listening.
     */
    disconnect(): void {
        if (this.boundListener) {
            window.removeEventListener('message', this.boundListener);
            this.boundListener = null;
        }
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeoutId);
            pending.reject(new Error('Bridge disconnected'));
        }
        this.pending.clear();
        this.iframe = null;
        this._isReady = false;
        this._isRunning = false;
    }

    /**
     * Register a handler for engine messages.
     */
    onMessage(handler: MessageHandler): () => void {
        this.handlers.push(handler);
        return () => {
            this.handlers = this.handlers.filter((h) => h !== handler);
        };
    }

    /**
     * Send a command to the engine iframe.
     */
    send(command: AppCommand): void {
        if (!this.iframe?.contentWindow) return;

        this.iframe.contentWindow.postMessage(
            { source: 'axiom-app', ...command },
            '*',
        );
    }

    /**
     * Send a request and wait for the engine's matching response.
     * The engine pairs request and response via `requestId`.
     *
     * Typed via the public `getSceneTree`/`getNodeInfo`/etc. wrappers — call
     * sites should not invoke this directly. The `partial` arg is a plain
     * object so the union's distributed Omit doesn't fight us.
     */
    private request<T>(
        partial: Record<string, unknown> & { type: string },
        timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
    ): Promise<T> {
        const requestId = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;

        return new Promise<T>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`Engine request '${partial.type}' timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pending.set(requestId, {
                resolve: resolve as (value: unknown) => void,
                reject,
                timeoutId,
            });

            this.send({ ...partial, requestId } as unknown as AppCommand);
        });
    }

    // ── Existing fire-and-forget commands ──────────────────────────

    startGame(files: FilePayload[]): void {
        this.send({ type: 'start', files });
    }

    stopGame(): void {
        this.send({ type: 'stop' });
    }

    syncFiles(files: FilePayload[]): void {
        this.send({ type: 'sync-files', files });
    }

    reloadScene(): void {
        this.send({ type: 'reload-scene' });
    }

    requestScreenshot(): void {
        this.send({ type: 'screenshot' });
    }

    // ── Sprint 0 — Protocol API ────────────────────────────────────

    /** Get the full live scene tree from the running engine. */
    getSceneTree(): Promise<SceneNodeSnapshot> {
        return this.request<SceneNodeSnapshot>({ type: 'scene-tree' });
    }

    /** Get the inspector data (properties + script) for a node. */
    getNodeInfo(path: string): Promise<NodeInspectorData> {
        return this.request<NodeInspectorData>({ type: 'node-info', path });
    }

    /** Hit-test a screen-space point against the live scene. */
    raycast(screenX: number, screenY: number): Promise<RaycastHit[]> {
        return this.request<RaycastHit[]>({ type: 'raycast', screenX, screenY });
    }

    /**
     * Set an arbitrary node property at runtime.
     * NOTE: Runtime-only — does not persist to the .scene file. Use saveScene()
     * to flush runtime state back to disk.
     */
    setProperty(path: string, property: string, value: unknown): Promise<void> {
        return this.request<void>({ type: 'set-property', path, property, value });
    }

    /** Shortcut for setting position/rotation/scale in one call. */
    setTransform(path: string, patch: TransformPatch): Promise<void> {
        return this.request<void>({ type: 'set-transform', path, patch });
    }

    addNode(parentPath: string, nodeType: string, nodeName: string): Promise<{ path: string }> {
        return this.request<{ path: string }>({
            type: 'add-node',
            parentPath,
            nodeType,
            nodeName,
        });
    }

    deleteNode(path: string): Promise<void> {
        return this.request<void>({ type: 'delete-node', path });
    }

    /** Highlight a node visually in the engine viewport. Pass null to clear. */
    selectNode(path: string | null): void {
        this.send({ type: 'select-node', path });
    }

    /** Switch the in-engine 3D gizmo tool: translate / rotate / scale / none. */
    setGizmoMode(mode: GizmoMode): void {
        this.send({ type: 'set-gizmo-mode', mode });
    }

    // ── Internal ───────────────────────────────────────────────────

    private handleMessage(event: MessageEvent): void {
        const data = event.data;
        if (!data || data.source !== 'axiom-engine') return;

        const msg = data as EngineMessage;

        // Track lifecycle state.
        if (msg.type === 'ready') this._isReady = true;
        if (msg.type === 'started') this._isRunning = true;
        if (msg.type === 'stopped') this._isRunning = false;

        // Resolve pending request if this is a response.
        if (msg.type === 'response') {
            const pending = this.pending.get(msg.requestId);
            if (pending) {
                clearTimeout(pending.timeoutId);
                this.pending.delete(msg.requestId);
                if (msg.ok) {
                    pending.resolve(msg.data);
                } else {
                    pending.reject(new Error(msg.error));
                }
            }
            // Responses are not fanned out to general handlers — they're 1:1.
            return;
        }

        for (const handler of this.handlers) {
            handler(msg);
        }
    }
}

/**
 * Singleton bridge instance for the app.
 */
export const engineBridge = new AxiomEngineBridge();

// Re-export protocol types as a convenience for consumers.
export type { Vec2, Vec3 };
