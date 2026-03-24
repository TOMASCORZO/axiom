/**
 * Axiom Engine — Bridge
 *
 * Communicates with the Axiom Engine running inside an iframe via postMessage.
 * This is the single interface between the React app and the WASM runtime.
 */

export type EngineMessage =
    | { type: 'ready' }
    | { type: 'started' }
    | { type: 'stopped'; exitCode?: number }
    | { type: 'fps'; value: number }
    | { type: 'progress'; value: number }
    | { type: 'console'; level: 'log' | 'warn' | 'error'; message: string }
    | { type: 'error'; message: string }
    | { type: 'screenshot'; dataUrl: string }
    | { type: 'files-synced' };

export type AppCommand =
    | { type: 'start'; files: Array<{ path: string; content: string }> }
    | { type: 'stop' }
    | { type: 'sync-files'; files: Array<{ path: string; content: string }> }
    | { type: 'reload-scene' }
    | { type: 'screenshot' };

type MessageHandler = (msg: EngineMessage) => void;

export class AxiomEngineBridge {
    private iframe: HTMLIFrameElement | null = null;
    private handlers: MessageHandler[] = [];
    private boundListener: ((event: MessageEvent) => void) | null = null;
    private _isReady = false;
    private _isRunning = false;

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
    }

    /**
     * Detach from the iframe and stop listening.
     */
    disconnect(): void {
        if (this.boundListener) {
            window.removeEventListener('message', this.boundListener);
            this.boundListener = null;
        }
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
     * Start the engine with project files.
     */
    startGame(files: Array<{ path: string; content: string }>): void {
        this.send({ type: 'start', files });
    }

    /**
     * Stop the running engine.
     */
    stopGame(): void {
        this.send({ type: 'stop' });
    }

    /**
     * Sync project files to the engine's virtual filesystem.
     */
    syncFiles(files: Array<{ path: string; content: string }>): void {
        this.send({ type: 'sync-files', files });
    }

    /**
     * Request a scene reload.
     */
    reloadScene(): void {
        this.send({ type: 'reload-scene' });
    }

    /**
     * Request a screenshot from the engine canvas.
     */
    requestScreenshot(): void {
        this.send({ type: 'screenshot' });
    }

    private handleMessage(event: MessageEvent): void {
        const data = event.data;
        if (!data || data.source !== 'axiom-engine') return;

        const msg = data as EngineMessage;

        // Track state
        if (msg.type === 'ready') this._isReady = true;
        if (msg.type === 'started') this._isRunning = true;
        if (msg.type === 'stopped') this._isRunning = false;

        // Notify all handlers
        for (const handler of this.handlers) {
            handler(msg);
        }
    }
}

/**
 * Singleton bridge instance for the app.
 */
export const engineBridge = new AxiomEngineBridge();
