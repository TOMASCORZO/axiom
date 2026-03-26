/**
 * MCP Tools — Expose MCP server management as agent tools.
 *
 * OpenCode pattern: Agent can connect/disconnect MCP servers and call their tools.
 */

import { registerTool, type ToolContext, type ToolInput } from './registry';
import { mcpManager } from '../../mcp';

// ── mcp_connect: Connect to an MCP server ───────────────────────────

registerTool({
    name: 'mcp_connect',
    description: 'Connect to an MCP (Model Context Protocol) server for additional tools and resources.',
    parameters: {
        name: { type: 'string', description: 'Unique name for the connection', required: true },
        transport: { type: 'string', description: 'Transport type: "stdio" or "sse"', required: true },
        command: { type: 'string', description: 'Command to start server (stdio only)' },
        args: { type: 'array', description: 'Command arguments (stdio only)' },
        url: { type: 'string', description: 'Server URL (sse only)' },
    },
    access: ['build'],
    requiresApproval: true,
    permissionPatterns: ['mcp:connect'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const success = await mcpManager.connect({
            name: input.name as string,
            transport: input.transport as 'stdio' | 'sse',
            command: input.command as string | undefined,
            args: input.args as string[] | undefined,
            url: input.url as string | undefined,
        });

        const tools = success ? mcpManager.getTools().filter(t => t.serverName === input.name) : [];

        return {
            success,
            output: success
                ? { message: `Connected to ${input.name}`, tools: tools.map(t => t.name), toolCount: tools.length }
                : null,
            error: success ? undefined : 'Connection failed',
            duration_ms: 0,
        };
    },
});

// ── mcp_call: Call a tool on an MCP server ──────────────────────────

registerTool({
    name: 'mcp_call',
    description: 'Call a tool provided by a connected MCP server.',
    parameters: {
        server: { type: 'string', description: 'MCP server name', required: true },
        tool: { type: 'string', description: 'Tool name (original, not prefixed)', required: true },
        args: { type: 'object', description: 'Tool arguments', required: true },
    },
    access: ['build'],
    async execute(ctx: ToolContext, input: ToolInput) {
        try {
            const result = await mcpManager.callTool(
                input.server as string,
                input.tool as string,
                input.args as Record<string, unknown>,
            );
            return {
                success: true,
                output: result,
                duration_ms: 0,
            };
        } catch (err) {
            return {
                success: false,
                output: null,
                error: err instanceof Error ? err.message : 'MCP call failed',
                duration_ms: 0,
            };
        }
    },
});

// ── mcp_list: List connected servers and their tools ────────────────

registerTool({
    name: 'mcp_list',
    description: 'List all connected MCP servers and their available tools.',
    parameters: {},
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const servers = mcpManager.status();
        const tools = mcpManager.getTools();
        return {
            success: true,
            output: {
                servers,
                tools: tools.map(t => ({ name: t.name, description: t.description, server: t.serverName })),
                totalTools: tools.length,
            },
            duration_ms: 0,
        };
    },
});

// ── mcp_disconnect: Disconnect from an MCP server ───────────────────

registerTool({
    name: 'mcp_disconnect',
    description: 'Disconnect from an MCP server.',
    parameters: {
        name: { type: 'string', description: 'Server name to disconnect', required: true },
    },
    access: ['build'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const success = await mcpManager.disconnect(input.name as string);
        return {
            success,
            output: success ? { message: `Disconnected from ${input.name}` } : null,
            error: success ? undefined : `Server "${input.name}" not found`,
            duration_ms: 0,
        };
    },
});
