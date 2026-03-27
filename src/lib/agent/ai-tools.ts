/**
 * AI SDK Tool Bridge — Converts Axiom ToolDefs to AI SDK tool() format.
 *
 * OpenCode pattern: tools are wrapped with the AI SDK's `tool()` helper so
 * that streamText() can auto-execute them. Each tool's execute() receives
 * the parsed args and returns the output string for the LLM.
 *
 * Key differences from the old system:
 * - AI SDK handles tool call parsing, execution, and result injection automatically
 * - No manual message history management for tool results
 * - Built-in tool repair via experimental_repairToolCall
 * - Tool results are automatically truncated and fed back to the model
 */

import { tool, jsonSchema, type ToolSet } from 'ai';
import { getToolsForAgent, getAllTools, type ToolContext } from './tools/registry';
import { truncateToolOutput } from './truncate';
import { bus } from '../bus';
import type { ToolResult } from '@/types/agent';

export interface ToolCallbacks {
    onToolStart?: (toolName: string, input: Record<string, unknown>, callId: string) => void;
    onToolResult?: (toolName: string, result: ToolResult) => void;
}

/**
 * Build the AI SDK ToolSet from registered Axiom tools.
 *
 * Each tool is wrapped to:
 * 1. Emit SSE events (onToolStart/onToolResult)
 * 2. Execute the tool via the existing registry
 * 3. Truncate output to prevent context overflow
 * 4. Return the result string for the LLM
 */
export function buildToolSet(
    agentType: string,
    toolCtx: ToolContext,
    callbacks: ToolCallbacks,
    deniedTools: string[] = [],
): ToolSet {
    const tools: ToolSet = {};
    const defs = agentType === '*' ? getAllTools() : getToolsForAgent(agentType);

    for (const def of defs) {
        if (deniedTools.includes(def.name)) continue;

        tools[def.name] = tool({
            description: def.description,
            inputSchema: jsonSchema(def.parameters as any),
            execute: async (args: any, options: { toolCallId: string }) => {
                const input = args as Record<string, unknown>;
                const callId = options.toolCallId || `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

                // Emit start event for SSE streaming
                callbacks.onToolStart?.(def.name, input, callId);
                bus.emit('tool.start', { toolName: def.name, input, callId });

                // Execute the tool using existing registry
                const start = Date.now();
                toolCtx.createdFiles = [];
                let result: ToolResult;

                try {
                    result = await def.execute(toolCtx, input);
                    if (toolCtx.createdFiles.length > 0) {
                        result.fileContents = [...toolCtx.createdFiles];
                    }
                    result.duration_ms = Date.now() - start;
                    result.callId = callId;
                } catch (error) {
                    result = {
                        callId,
                        success: false,
                        output: {},
                        filesModified: [],
                        error: error instanceof Error ? error.message : 'Tool execution failed',
                        duration_ms: Date.now() - start,
                    };
                }

                // Emit result event for SSE streaming
                callbacks.onToolResult?.(def.name, result);
                bus.emit('tool.complete', {
                    toolName: def.name,
                    success: result.success,
                    duration_ms: result.duration_ms,
                    callId,
                });

                // Return truncated output string for the LLM
                const rawContent = result.success
                    ? JSON.stringify(result.output)
                    : JSON.stringify({
                        error: result.error,
                        hint: 'The tool failed. Read the error carefully and try a different approach.',
                    });

                const truncated = truncateToolOutput(rawContent);
                if (truncated.truncated) {
                    bus.emit('truncation.applied', {
                        toolName: def.name,
                        originalLength: truncated.originalLength,
                        truncatedLength: truncated.content.length,
                    });
                }

                return truncated.content;
            },
        });
    }

    // Add an "invalid" tool for tool repair (OpenCode pattern)
    tools['invalid'] = tool({
        description: 'This tool does not exist. The tool name was not recognized.',
        inputSchema: jsonSchema({
            type: 'object',
            properties: {
                tool: { type: 'string', description: 'The tool name that was attempted' },
                error: { type: 'string', description: 'The error message' },
            },
        }),
        execute: async (args: any) => {
            const availableTools = defs.map(d => d.name).join(', ');
            return `Unknown tool: "${args.tool}". Available tools: ${availableTools}. Please use one of the available tools.`;
        },
    });

    return tools;
}
