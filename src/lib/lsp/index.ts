/**
 * LSP Client Manager — Language Server Protocol integration for Axiom.
 *
 * OpenCode pattern: Manages local language server processes to provide
 * IDE-level code intelligence to the agent. Instead of regex-based search,
 * the agent can query semantic information like definitions, references,
 * hover info, and real-time diagnostics.
 *
 * Supported language servers:
 * - TypeScript/JavaScript: typescript-language-server
 * - Python: pyright / pylsp
 * - GDScript: godot language server (future)
 *
 * Usage:
 *   import { lspManager } from '@/lib/lsp';
 *
 *   await lspManager.start('typescript', { rootUri: '/project' });
 *   const defs = await lspManager.definition('typescript', 'file:///src/main.ts', 10, 5);
 *   const diags = await lspManager.diagnostics('typescript', 'file:///src/main.ts');
 */

import { spawn, type ChildProcess } from 'child_process';
import { bus } from '../bus';

// ── Types ───────────────────────────────────────────────────────────

export interface LspServerConfig {
    /** Language identifier */
    language: string;
    /** Command to start the LSP server */
    command: string;
    /** Arguments for the command */
    args: string[];
    /** Root URI of the project */
    rootUri: string;
}

export interface LspPosition {
    line: number;
    character: number;
}

export interface LspLocation {
    uri: string;
    range: { start: LspPosition; end: LspPosition };
}

export interface LspDiagnostic {
    range: { start: LspPosition; end: LspPosition };
    severity: 'error' | 'warning' | 'info' | 'hint';
    message: string;
    source?: string;
}

export interface LspHoverResult {
    contents: string;
    range?: { start: LspPosition; end: LspPosition };
}

interface LspServerInstance {
    config: LspServerConfig;
    process: ChildProcess;
    status: 'starting' | 'ready' | 'error' | 'stopped';
    requestId: number;
    pendingRequests: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
    buffer: string;
}

// ── Known Language Server Configs ───────────────────────────────────

const KNOWN_SERVERS: Record<string, Omit<LspServerConfig, 'rootUri'>> = {
    typescript: {
        language: 'typescript',
        command: 'npx',
        args: ['typescript-language-server', '--stdio'],
    },
    python: {
        language: 'python',
        command: 'pyright-langserver',
        args: ['--stdio'],
    },
};

// ── LSP Manager ─────────────────────────────────────────────────────

class LspManager {
    private servers = new Map<string, LspServerInstance>();

    /**
     * Start a language server for the given language.
     */
    async start(language: string, options: { rootUri: string }): Promise<boolean> {
        if (this.servers.has(language)) {
            return true; // Already running
        }

        const known = KNOWN_SERVERS[language];
        if (!known) {
            console.error(`[LSP] Unknown language server: ${language}`);
            return false;
        }

        const config: LspServerConfig = { ...known, rootUri: options.rootUri };

        try {
            const proc = spawn(config.command, config.args, {
                cwd: options.rootUri,
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            const instance: LspServerInstance = {
                config,
                process: proc,
                status: 'starting',
                requestId: 0,
                pendingRequests: new Map(),
                buffer: '',
            };

            proc.stdout?.on('data', (data: Buffer) => {
                this.handleData(instance, data.toString());
            });

            proc.stderr?.on('data', (data: Buffer) => {
                console.error(`[LSP:${language}] ${data.toString()}`);
            });

            proc.on('exit', (code) => {
                instance.status = 'stopped';
                this.servers.delete(language);
                bus.emit('tool.complete', {
                    toolName: `lsp:${language}`,
                    success: code === 0,
                    duration_ms: 0,
                    callId: language,
                });
            });

            proc.on('error', (err) => {
                instance.status = 'error';
                console.error(`[LSP:${language}] Failed to start: ${err.message}`);
            });

            this.servers.set(language, instance);

            // Send initialize request
            await this.sendRequest(instance, 'initialize', {
                processId: process.pid,
                rootUri: `file://${options.rootUri}`,
                capabilities: {
                    textDocument: {
                        definition: { dynamicRegistration: false },
                        references: { dynamicRegistration: false },
                        hover: { contentFormat: ['plaintext'] },
                        publishDiagnostics: { relatedInformation: true },
                    },
                },
            });

            // Send initialized notification
            this.sendNotification(instance, 'initialized', {});
            instance.status = 'ready';

            bus.emit('tool.start', {
                toolName: `lsp:${language}`,
                input: { rootUri: options.rootUri },
                callId: language,
            });

            return true;
        } catch (err) {
            console.error(`[LSP:${language}] Start failed:`, err);
            return false;
        }
    }

    /**
     * Go to definition of a symbol at position.
     */
    async definition(language: string, uri: string, line: number, character: number): Promise<LspLocation[]> {
        const instance = this.getServer(language);
        const result = await this.sendRequest(instance, 'textDocument/definition', {
            textDocument: { uri },
            position: { line, character },
        });
        if (!result) return [];
        return Array.isArray(result) ? result as LspLocation[] : [result as LspLocation];
    }

    /**
     * Find all references of a symbol at position.
     */
    async references(language: string, uri: string, line: number, character: number): Promise<LspLocation[]> {
        const instance = this.getServer(language);
        const result = await this.sendRequest(instance, 'textDocument/references', {
            textDocument: { uri },
            position: { line, character },
            context: { includeDeclaration: true },
        });
        return Array.isArray(result) ? result as LspLocation[] : [];
    }

    /**
     * Get hover information at position.
     */
    async hover(language: string, uri: string, line: number, character: number): Promise<LspHoverResult | null> {
        const instance = this.getServer(language);
        const result = await this.sendRequest(instance, 'textDocument/hover', {
            textDocument: { uri },
            position: { line, character },
        }) as { contents: { value?: string; kind?: string } | string; range?: LspHoverResult['range'] } | null;
        if (!result) return null;
        const contents = typeof result.contents === 'string' ? result.contents : result.contents?.value ?? '';
        return { contents, range: result.range };
    }

    /**
     * Get the status of all managed LSP servers.
     */
    status(): Array<{ language: string; status: string }> {
        return Array.from(this.servers.entries()).map(([lang, inst]) => ({
            language: lang,
            status: inst.status,
        }));
    }

    /**
     * Stop a language server.
     */
    async stop(language: string): Promise<boolean> {
        const instance = this.servers.get(language);
        if (!instance) return false;

        try {
            await this.sendRequest(instance, 'shutdown', null);
            this.sendNotification(instance, 'exit', null);
        } catch {
            // Force kill if graceful shutdown fails
            instance.process.kill('SIGTERM');
        }

        instance.status = 'stopped';
        this.servers.delete(language);
        return true;
    }

    /**
     * Stop all language servers.
     */
    async stopAll(): Promise<void> {
        for (const language of Array.from(this.servers.keys())) {
            await this.stop(language);
        }
    }

    // ── Internal LSP Protocol Methods ───────────────────────────────

    private getServer(language: string): LspServerInstance {
        const instance = this.servers.get(language);
        if (!instance) throw new Error(`LSP server for "${language}" is not running. Call start() first.`);
        if (instance.status !== 'ready') throw new Error(`LSP server for "${language}" is not ready (status: ${instance.status})`);
        return instance;
    }

    private sendRequest(instance: LspServerInstance, method: string, params: unknown): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const id = ++instance.requestId;
            instance.pendingRequests.set(id, { resolve, reject });

            const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
            const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;

            instance.process.stdin?.write(header + message);

            // Timeout after 10 seconds
            setTimeout(() => {
                if (instance.pendingRequests.has(id)) {
                    instance.pendingRequests.delete(id);
                    reject(new Error(`LSP request "${method}" timed out`));
                }
            }, 10_000);
        });
    }

    private sendNotification(instance: LspServerInstance, method: string, params: unknown): void {
        const message = JSON.stringify({ jsonrpc: '2.0', method, params });
        const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;
        instance.process.stdin?.write(header + message);
    }

    private handleData(instance: LspServerInstance, data: string): void {
        instance.buffer += data;

        while (true) {
            const headerEnd = instance.buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) break;

            const header = instance.buffer.slice(0, headerEnd);
            const match = header.match(/Content-Length:\s*(\d+)/i);
            if (!match) {
                instance.buffer = instance.buffer.slice(headerEnd + 4);
                continue;
            }

            const contentLength = parseInt(match[1], 10);
            const bodyStart = headerEnd + 4;
            if (instance.buffer.length < bodyStart + contentLength) break;

            const body = instance.buffer.slice(bodyStart, bodyStart + contentLength);
            instance.buffer = instance.buffer.slice(bodyStart + contentLength);

            try {
                const msg = JSON.parse(body);
                if (msg.id !== undefined && instance.pendingRequests.has(msg.id)) {
                    const pending = instance.pendingRequests.get(msg.id)!;
                    instance.pendingRequests.delete(msg.id);
                    if (msg.error) {
                        pending.reject(new Error(msg.error.message));
                    } else {
                        pending.resolve(msg.result);
                    }
                }
            } catch {
                // Malformed JSON, skip
            }
        }
    }
}

// ── Singleton Export ─────────────────────────────────────────────────

/** Global LSP manager instance */
export const lspManager = new LspManager();

export { LspManager };
