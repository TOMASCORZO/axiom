/**
 * Legacy Agent Loop Wrapper -> QueryEngine Bridge
 * Maintains the old AgentResult interface for backwards compatibility
 * while delegating to the streaming QueryEngine.
 */

import { ChatProvider, ToolSchema } from './providers';
import { getToolsForAgent, ToolContext } from './tools/registry';
import { ToolResult, Message } from '../../types/agent';
import { AGENT_DEFS, AgentType } from './agents/types';
import { QueryEngine } from './engine/QueryEngine';
import { recordTokenUsage } from './cost';
import { randomUUID } from 'crypto';

function normalizeSchema(params: Record<string, unknown>): Record<string, unknown> {
    if (params.type === 'object' && params.properties) return params;
    if (!params || Object.keys(params).length === 0) return { type: 'object', properties: {} };

    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, val] of Object.entries(params)) {
        if (val && typeof val === 'object' && 'type' in (val as any)) {
            const { required: isReq, ...rest } = val as any;
            properties[key] = rest;
            if (isReq) required.push(key);
        } else {
            properties[key] = val;
        }
    }
    const schema: Record<string, unknown> = { type: 'object', properties };
    if (required.length > 0) schema.required = required;
    return schema;
}

export interface AgentResult {
    response: string;
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown>; result: ToolResult }>;
    totalTokens: number;
    iterations: number;
}

export interface LoopCallbacks {
    onToolStart?: (toolName: string, input: Record<string, unknown>, callId: string) => void;
    onToolResult?: (toolName: string, result: ToolResult) => void;
    onIteration?: (iteration: number) => void;
    onReasoning?: (reasoning: string) => void;
    onText?: (text: string) => void;
}

export interface LoopParams {
    provider: ChatProvider;
    systemPrompt: string;
    userMessage: string;
    agentType: AgentType;
    toolCtx: ToolContext;
    callbacks: LoopCallbacks;
    historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
    skipForceFirstTool?: boolean;
    maxIterations?: number;
    sessionId?: string;
}

export async function runAgentLoop(params: LoopParams): Promise<AgentResult> {
    const { provider, systemPrompt, userMessage, agentType, toolCtx, callbacks } = params;
    const agentDef = AGENT_DEFS[agentType];

    const agentTools = getToolsForAgent(agentType);
    const filteredTools = agentTools.filter(t => !agentDef.deniedTools.includes(t.name));
    const toolSchemas: ToolSchema[] = filteredTools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: normalizeSchema(t.parameters),
    }));

    const fullSystemPrompt = systemPrompt + '\n' + agentDef.systemSuffix;

    const initialHistory: Message[] = (params.historyMessages ?? []).map(h => ({
        type: h.role,
        uuid: randomUUID(),
        message: h.role === 'assistant'
            ? { content: [{ type: 'text' as const, text: h.content }] }
            : { content: h.content }
    })) as Message[];

    // Collect tool calls from callbacks for the legacy AgentResult
    const toolCalls: AgentResult['toolCalls'] = [];

    const wrappedOnToolStart = (toolName: string, input: Record<string, unknown>, callId: string) => {
        callbacks.onToolStart?.(toolName, input, callId);
    };

    const wrappedOnToolResult = (toolName: string, result: ToolResult) => {
        toolCalls.push({
            id: result.callId ?? randomUUID(),
            name: toolName,
            input: {},
            result
        });
        callbacks.onToolResult?.(toolName, result);
    };

    const engine = new QueryEngine({
        provider,
        systemPrompt: fullSystemPrompt,
        tools: toolSchemas,
        toolCtx,
        maxTokens: 8192,
        maxIterations: params.maxIterations ?? agentDef.maxIterations,
        callbacks: {
            onToolStart: wrappedOnToolStart,
            onToolResult: wrappedOnToolResult,
            onIteration: callbacks.onIteration
        }
    }, initialHistory);

    let totalTokens = 0;

    const stream = engine.submitMessage(userMessage);
    let finalPayload: any;

    while (true) {
        const { value, done } = await stream.next();
        if (done) {
            finalPayload = value;
            break;
        }

        const event = value;
        if (event.type === 'message_start') {
            const usage = event.message?.usage;
            if (usage) {
                const stepTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
                totalTokens += stepTokens;
                if (params.sessionId) {
                    recordTokenUsage(params.sessionId, 'claude-3-7-sonnet-20250219', {
                        inputTokens: usage.inputTokens || 0,
                        outputTokens: usage.outputTokens || 0,
                        cacheReadTokens: 0,
                        cacheCreationTokens: 0,
                    });
                }
            }
        } else if (event.type === 'message_delta') {
            const outTokens = event.usage?.outputTokens || 0;
            totalTokens += outTokens;
            if (params.sessionId && outTokens > 0) {
                recordTokenUsage(params.sessionId, 'claude-3-7-sonnet-20250219', {
                    inputTokens: 0,
                    outputTokens: outTokens,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                });
            }
        } else if (event.type === 'content_block_delta') {
            if ('text' in event.delta && event.delta.type === 'text_delta') {
                callbacks.onText?.(event.delta.text);
            } else if ('text' in event.delta && event.delta.type === 'reasoning_delta') {
                callbacks.onReasoning?.(event.delta.text);
            }
        }
    }

    if (!finalPayload) {
        throw new Error('Engine stream terminated without returning final state');
    }

    const textBlocks = finalPayload.assistantMsg.message.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text);

    return {
        response: textBlocks.join('\n\n') || 'Task completed.',
        toolCalls,
        totalTokens,
        iterations: finalPayload.iterations
    };
}
