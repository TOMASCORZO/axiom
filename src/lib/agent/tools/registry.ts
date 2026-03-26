/**
 * Tool Registry — OpenCode-faithful tool system.
 *
 * Key OpenCode patterns:
 * - Tool.define() factory with id, parameters (zod-style), execute
 * - Flat registry, agents filter by access
 * - executeTool wraps with error handling, timing, file tracking
 * - Tool repair: if name doesn't match, try lowercase, else return "invalid"
 */

import type { ToolResult, ToolFileData } from '@/types/agent';

export type ToolInput = Record<string, unknown>;

export interface ToolContext {
    projectId: string;
    userId: string;
    createdFiles: ToolFileData[];
    supabase: import('@supabase/supabase-js').SupabaseClient;
}

export interface ToolDef {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    access: ('build' | 'plan' | 'explore')[];
    execute: (ctx: ToolContext, input: ToolInput) => Promise<ToolResult>;
}

const _tools = new Map<string, ToolDef>();

export function registerTool(def: ToolDef) {
    _tools.set(def.name, def);
}

export function getTool(name: string): ToolDef | undefined {
    return _tools.get(name);
}

export function getToolsForAgent(agentType: 'build' | 'plan' | 'explore'): ToolDef[] {
    return Array.from(_tools.values()).filter(t => t.access.includes(agentType));
}

export function getAllTools(): ToolDef[] {
    return Array.from(_tools.values());
}

export function getToolSchemas(agentType: 'build' | 'plan' | 'explore'): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return getToolsForAgent(agentType).map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
    }));
}

/**
 * Repair a tool name — OpenCode pattern.
 * If the exact name doesn't exist, try lowercase.
 * If still not found, return null (caller should use "invalid" tool).
 */
function repairToolName(name: string): string | null {
    if (_tools.has(name)) return name;
    const lower = name.toLowerCase();
    if (_tools.has(lower)) return lower;
    // Try matching by prefix
    for (const key of _tools.keys()) {
        if (key.toLowerCase() === lower) return key;
    }
    return null;
}

/**
 * Execute a tool by name — master dispatcher.
 * Implements OpenCode patterns:
 * - Tool name repair (lowercase fallback)
 * - Invalid tool response for unknown tools
 * - createdFiles reset per call
 * - Timing
 */
export async function executeTool(name: string, input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    const repairedName = repairToolName(name);

    if (!repairedName) {
        // OpenCode returns a helpful error for invalid tools
        return {
            callId: '',
            success: false,
            output: {
                tool: name,
                error: `Unknown tool: "${name}". Available tools: ${Array.from(_tools.keys()).join(', ')}`,
            },
            filesModified: [],
            error: `The ${name} tool is not available. Please use one of the available tools.`,
            duration_ms: Date.now() - start,
        };
    }

    const tool = _tools.get(repairedName)!;
    ctx.createdFiles = [];

    try {
        const result = await tool.execute(ctx, input);
        if (ctx.createdFiles.length > 0) {
            result.fileContents = [...ctx.createdFiles];
        }
        result.duration_ms = Date.now() - start;
        return result;
    } catch (error) {
        return {
            callId: '',
            success: false,
            output: {},
            filesModified: [],
            error: error instanceof Error ? error.message : 'Tool execution failed',
            duration_ms: Date.now() - start,
        };
    }
}
