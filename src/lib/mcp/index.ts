/**
 * MCP Client — Model Context Protocol integration for Axiom.
 *
 * OpenCode pattern: Connect to external MCP servers (local or remote)
 * to dynamically inject tools, prompts, and resources into the agent's
 * capabilities at runtime. Servers can provide tools via stdio or SSE.
 *
 * MCP Spec: https://modelcontextprotocol.io
 *
 * Usage:
 *   import { mcpManager } from '@/lib/mcp';
 *
 *   await mcpManager.connect({
 *     name: 'filesystem',
 *     transport: 'stdio',
 *     command: 'npx',
 *     args: ['-y', '@modelcontextprotocol/server-filesystem', '/project'],
 *   });
 *
 *   const tools = mcpManager.getTools();  // Merged with Axiom's native tools
 */

import { spawn, type ChildProcess } from 'child_process';
import { bus } from '../bus';

// ── Types ───────────────────────────────────────────────────────────

export interface McpServerConfig {
    /** Unique name for this server connection */
    name: string;
    /** Transport type */
    transport: 'stdio' | 'sse';
    /** Command to start the server (stdio only) */
    command?: string;
    /** Arguments for the command (stdio only) */
    args?: string[];
    /** URL for SSE transport */
    url?: string;
    /** Environment variables for the server process */
    env?: Record<string, string>;
}

export interface McpTool {
    /** Tool name (prefixed with server name: "server_name.tool_name") */
    name: string;
    /** Original tool name from the server */
    originalName: string;
    /** Which server provides this tool */
    serverName: string;
    /** Tool description */
    description: string;
    /** JSON Schema for the tool's input */
    inputSchema: Record<string, unknown>;
}

export interface McpResource {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
    serverName: string;
}

interface McpConnection {
    config: McpServerConfig;
    process?: ChildProcess;
    status: 'connecting' | 'ready' | 'error' | 'disconnected';
    tools: McpTool[];
    resources: McpResource[];
    requestId: number;
    pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
    buffer: string;
}

// ── MCP Manager ─────────────────────────────────────────────────────

class McpManager {
    private connections = new Map<string, McpConnection>();

    /**
     * Connect to an MCP server.
     */
    async connect(config: McpServerConfig): Promise<boolean> {
        if (this.connections.has(config.name)) {
            console.warn(`[MCP] Server "${config.name}" already connected`);
            return true;
        }

        if (config.transport === 'stdio') {
            return this.connectStdio(config);
        } else if (config.transport === 'sse') {
            return this.connectSse(config);
        }

        console.error(`[MCP] Unknown transport: ${config.transport}`);
        return false;
    }

    /**
     * Disconnect from an MCP server.
     */
    async disconnect(name: string): Promise<boolean> {
        const conn = this.connections.get(name);
        if (!conn) return false;

        if (conn.process) {
            conn.process.kill('SIGTERM');
        }
        conn.status = 'disconnected';
        this.connections.delete(name);
        return true;
    }

    /**
     * Get all tools from all connected MCP servers.
     * Tools are namespaced: "serverName.toolName"
     */
    getTools(): McpTool[] {
        const tools: McpTool[] = [];
        for (const conn of this.connections.values()) {
            if (conn.status === 'ready') {
                tools.push(...conn.tools);
            }
        }
        return tools;
    }

    /**
     * Get all resources from all connected MCP servers.
     */
    getResources(): McpResource[] {
        const resources: McpResource[] = [];
        for (const conn of this.connections.values()) {
            if (conn.status === 'ready') {
                resources.push(...conn.resources);
            }
        }
        return resources;
    }

    /**
     * Call a tool on an MCP server.
     */
    async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
        const conn = this.connections.get(serverName);
        if (!conn || conn.status !== 'ready') {
            throw new Error(`MCP server "${serverName}" is not connected or not ready`);
        }

        return this.sendRequest(conn, 'tools/call', { name: toolName, arguments: args });
    }

    /**
     * Read a resource from an MCP server.
     */
    async readResource(serverName: string, uri: string): Promise<unknown> {
        const conn = this.connections.get(serverName);
        if (!conn || conn.status !== 'ready') {
            throw new Error(`MCP server "${serverName}" is not connected`);
        }

        return this.sendRequest(conn, 'resources/read', { uri });
    }

    /**
     * Get the status of all MCP connections.
     */
    status(): Array<{ name: string; status: string; toolCount: number; resourceCount: number }> {
        return Array.from(this.connections.entries()).map(([name, conn]) => ({
            name,
            status: conn.status,
            toolCount: conn.tools.length,
            resourceCount: conn.resources.length,
        }));
    }

    /**
     * Disconnect all servers.
     */
    async disconnectAll(): Promise<void> {
        for (const name of Array.from(this.connections.keys())) {
            await this.disconnect(name);
        }
    }

    // ── Stdio Transport ─────────────────────────────────────────────

    private async connectStdio(config: McpServerConfig): Promise<boolean> {
        if (!config.command) {
            console.error('[MCP] Stdio transport requires a command');
            return false;
        }

        try {
            const proc = spawn(config.command, config.args ?? [], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, ...config.env },
            });

            const conn: McpConnection = {
                config,
                process: proc,
                status: 'connecting',
                tools: [],
                resources: [],
                requestId: 0,
                pendingRequests: new Map(),
                buffer: '',
            };

            proc.stdout?.on('data', (data: Buffer) => {
                this.handleStdioData(conn, data.toString());
            });

            proc.stderr?.on('data', (data: Buffer) => {
                console.error(`[MCP:${config.name}] ${data.toString()}`);
            });

            proc.on('exit', (code) => {
                conn.status = 'disconnected';
                this.connections.delete(config.name);
                bus.emit('tool.complete', {
                    toolName: `mcp:${config.name}`,
                    success: code === 0,
                    duration_ms: 0,
                });
            });

            proc.on('error', (err) => {
                conn.status = 'error';
                console.error(`[MCP:${config.name}] Process error: ${err.message}`);
            });

            this.connections.set(config.name, conn);

            // Initialize the MCP session
            await this.sendRequest(conn, 'initialize', {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {}, resources: {} },
                clientInfo: { name: 'axiom', version: '1.0.0' },
            });

            // Send initialized notification
            this.sendNotification(conn, 'notifications/initialized', {});

            // Discover tools
            try {
                const toolsResult = await this.sendRequest(conn, 'tools/list', {}) as { tools?: McpTool[] };
                conn.tools = (toolsResult?.tools ?? []).map(t => ({
                    name: `${config.name}.${(t as unknown as { name: string }).name}`,
                    originalName: (t as unknown as { name: string }).name,
                    serverName: config.name,
                    description: (t as unknown as { description: string }).description ?? '',
                    inputSchema: (t as unknown as { inputSchema: Record<string, unknown> }).inputSchema ?? {},
                }));
            } catch {
                // Server may not support tools listing
            }

            // Discover resources
            try {
                const resourcesResult = await this.sendRequest(conn, 'resources/list', {}) as { resources?: McpResource[] };
                conn.resources = (resourcesResult?.resources ?? []).map(r => ({
                    ...(r as unknown as McpResource),
                    serverName: config.name,
                }));
            } catch {
                // Server may not support resources listing
            }

            conn.status = 'ready';

            bus.emit('tool.start', {
                toolName: `mcp:${config.name}`,
                input: { transport: 'stdio', tools: conn.tools.length },
            });

            return true;
        } catch (err) {
            console.error(`[MCP:${config.name}] Connection failed:`, err);
            return false;
        }
    }

    // ── SSE Transport (placeholder) ─────────────────────────────────

    private async connectSse(config: McpServerConfig): Promise<boolean> {
        if (!config.url) {
            console.error('[MCP] SSE transport requires a URL');
            return false;
        }

        // SSE transport implementation
        // Uses fetch with EventSource-like pattern
        const conn: McpConnection = {
            config,
            status: 'connecting',
            tools: [],
            resources: [],
            requestId: 0,
            pendingRequests: new Map(),
            buffer: '',
        };

        this.connections.set(config.name, conn);

        try {
            // For SSE, we use HTTP POST for requests and SSE for responses
            const initResult = await fetch(`${config.url}/initialize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {}, resources: {} },
                    clientInfo: { name: 'axiom', version: '1.0.0' },
                }),
            });

            if (!initResult.ok) {
                conn.status = 'error';
                return false;
            }

            // List tools via HTTP
            try {
                const toolsRes = await fetch(`${config.url}/tools/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                const toolsData = await toolsRes.json() as { tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> };
                conn.tools = (toolsData?.tools ?? []).map(t => ({
                    name: `${config.name}.${t.name}`,
                    originalName: t.name,
                    serverName: config.name,
                    description: t.description ?? '',
                    inputSchema: t.inputSchema ?? {},
                }));
            } catch { /* */ }

            conn.status = 'ready';
            return true;
        } catch (err) {
            conn.status = 'error';
            console.error(`[MCP:${config.name}] SSE connection failed:`, err);
            return false;
        }
    }

    // ── JSON-RPC over Stdio ─────────────────────────────────────────

    private sendRequest(conn: McpConnection, method: string, params: unknown): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const id = ++conn.requestId;
            conn.pendingRequests.set(id, { resolve, reject });

            const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
            const frame = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;

            if (conn.process?.stdin) {
                conn.process.stdin.write(frame);
            }

            setTimeout(() => {
                if (conn.pendingRequests.has(id)) {
                    conn.pendingRequests.delete(id);
                    reject(new Error(`MCP request "${method}" timed out`));
                }
            }, 15_000);
        });
    }

    private sendNotification(conn: McpConnection, method: string, params: unknown): void {
        const message = JSON.stringify({ jsonrpc: '2.0', method, params });
        const frame = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
        conn.process?.stdin?.write(frame);
    }

    private handleStdioData(conn: McpConnection, data: string): void {
        conn.buffer += data;

        while (true) {
            const headerEnd = conn.buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) break;

            const header = conn.buffer.slice(0, headerEnd);
            const match = header.match(/Content-Length:\s*(\d+)/i);
            if (!match) {
                conn.buffer = conn.buffer.slice(headerEnd + 4);
                continue;
            }

            const contentLength = parseInt(match[1], 10);
            const bodyStart = headerEnd + 4;
            if (conn.buffer.length < bodyStart + contentLength) break;

            const body = conn.buffer.slice(bodyStart, bodyStart + contentLength);
            conn.buffer = conn.buffer.slice(bodyStart + contentLength);

            try {
                const msg = JSON.parse(body);
                if (msg.id !== undefined && conn.pendingRequests.has(msg.id)) {
                    const pending = conn.pendingRequests.get(msg.id)!;
                    conn.pendingRequests.delete(msg.id);
                    if (msg.error) {
                        pending.reject(new Error(msg.error.message ?? 'MCP error'));
                    } else {
                        pending.resolve(msg.result);
                    }
                }
            } catch {
                // Malformed JSON
            }
        }
    }
}

// ── Singleton Export ─────────────────────────────────────────────────

/** Global MCP manager instance */
export const mcpManager = new McpManager();

export { McpManager };
