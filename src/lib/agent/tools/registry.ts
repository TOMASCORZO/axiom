/**
 * Tool Registry — Claude Code-style tool system.
 *
 * Key CC patterns:
 * - Each tool declares isReadOnly, isConcurrencySafe, isDestructive, maxResultSizeChars
 * - executeTool: permission check → validate → call → truncate large results
 * - Tool name repair (lowercase fallback)
 * - AbortController integration via ToolContext
 */

import type { ToolResult, ToolFileData } from '@/types/agent';
import { bus } from '../../bus';

export type ToolInput = Record<string, unknown>;

export interface ToolContext {
    projectId: string;
    userId: string;
    createdFiles: ToolFileData[];
    supabase: import('@supabase/supabase-js').SupabaseClient;
    /** AbortController for cancelling in-flight operations */
    abortController?: AbortController;
}

export type PermissionMode = 'default' | 'plan' | 'auto_accept';

export interface ToolDef {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    access: ('build' | 'plan' | 'explore')[];

    // CC-style metadata
    /** Is this tool read-only (safe in plan mode)? Default: false */
    isReadOnly?: boolean;
    /** Can multiple instances of this tool run in parallel? Default: false */
    isConcurrencySafe?: boolean;
    /** Does this tool perform irreversible operations? Default: false */
    isDestructive?: boolean;
    /** Max characters for tool result before truncation. Default: 30000 */
    maxResultSizeChars?: number;

    /** If true, emits a permission.request event and waits for approval */
    requiresApproval?: boolean;
    /** Patterns that describe what this tool affects */
    permissionPatterns?: string[];

    /** Optional input validation. Return string error message or null if valid. */
    validateInput?: (input: ToolInput, ctx: ToolContext) => Promise<string | null>;

    execute: (ctx: ToolContext, input: ToolInput) => Promise<ToolResult>;
}

const _tools = new Map<string, ToolDef>();

export function registerTool(def: ToolDef) {
    _tools.set(def.name, def);
}

export function getTool(name: string): ToolDef | undefined {
    return _tools.get(name);
}

export function getToolsForAgent(agentType: string): ToolDef[] {
    return Array.from(_tools.values()).filter(t => t.access.includes(agentType as any));
}

export function getAllTools(): ToolDef[] {
    return Array.from(_tools.values());
}

export function getToolSchemas(agentType: string): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return getToolsForAgent(agentType).map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
    }));
}

/**
 * Repair a tool name — if exact name doesn't exist, try case-insensitive match.
 */
function repairToolName(name: string): string | null {
    if (_tools.has(name)) return name;
    const lower = name.toLowerCase();
    if (_tools.has(lower)) return lower;
    for (const key of _tools.keys()) {
        if (key.toLowerCase() === lower) return key;
    }
    return null;
}

/**
 * Truncate tool result output if it exceeds maxResultSizeChars.
 * CC pattern: large results get persisted to disk and replaced with a preview.
 * We simplify to inline truncation.
 */
function truncateResult(result: ToolResult, maxChars: number): ToolResult {
    if (!result.output) return result;
    const outputStr = typeof result.output === 'string'
        ? result.output
        : JSON.stringify(result.output);

    if (outputStr.length <= maxChars) return result;

    const truncated = outputStr.slice(0, maxChars)
        + `\n\n...[Output truncated. Full output was ${outputStr.length} chars, showing first ${maxChars}.]`;

    return {
        ...result,
        output: truncated,
    };
}

/**
 * Execute a tool by name — master dispatcher.
 * CC pattern: validate → permission check → execute → truncate
 */
export async function executeTool(
    name: string,
    input: ToolInput,
    ctx: ToolContext,
    permissionMode: PermissionMode = 'default'
): Promise<ToolResult> {
    const start = Date.now();
    const repairedName = repairToolName(name);

    if (!repairedName) {
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

    // Check abort before starting
    if (ctx.abortController?.signal.aborted) {
        return {
            callId: '', success: false, output: null, filesModified: [],
            error: 'Operation was cancelled.',
            duration_ms: Date.now() - start,
        };
    }

    // Plan mode enforcement: block non-read-only tools
    if (permissionMode === 'plan' && !tool.isReadOnly) {
        return {
            callId: '', success: false, output: null, filesModified: [],
            error: `Tool "${repairedName}" is blocked in plan mode (not read-only). Exit plan mode first.`,
            duration_ms: Date.now() - start,
        };
    }

    // Input validation
    if (tool.validateInput) {
        const validationError = await tool.validateInput(input, ctx);
        if (validationError) {
            return {
                callId: '', success: false, output: null, filesModified: [],
                error: `Input validation failed: ${validationError}`,
                duration_ms: Date.now() - start,
            };
        }
    }

    // Interactive approval gate
    if (tool.requiresApproval && permissionMode === 'default') {
        const approved = await requestPermission(repairedName, tool.permissionPatterns ?? ['*']);
        if (!approved) {
            return {
                callId: '', success: false, output: {},  filesModified: [],
                error: `Tool "${repairedName}" was denied by the user. Try a different approach.`,
                duration_ms: Date.now() - start,
            };
        }
    }

    try {
        let result = await tool.execute(ctx, input);
        if (ctx.createdFiles.length > 0) {
            result.fileContents = [...ctx.createdFiles];
        }
        result.duration_ms = Date.now() - start;

        // Truncate large results
        const maxChars = tool.maxResultSizeChars ?? 30_000;
        result = truncateResult(result, maxChars);

        return result;
    } catch (error) {
        return {
            callId: '', success: false, output: {}, filesModified: [],
            error: error instanceof Error ? error.message : 'Tool execution failed',
            duration_ms: Date.now() - start,
        };
    }
}

/**
 * Request permission from the user via the Event Bus.
 */
function requestPermission(toolName: string, patterns: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        const TIMEOUT_MS = 30_000;
        const unsub = bus.on('permission.response', (payload) => {
            if (payload.toolName === toolName) {
                clearTimeout(timer);
                unsub();
                resolve(payload.granted);
            }
        });
        const timer = setTimeout(() => { unsub(); resolve(true); }, TIMEOUT_MS);
        bus.emit('permission.request', { toolName, permission: 'execute', patterns });
    });
}
