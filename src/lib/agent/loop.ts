/**
 * Agent Loop — simple manual agentic loop.
 *
 * 1. Send messages + tools to the provider
 * 2. If the model returns tool calls → execute them → send results → repeat
 * 3. If the model is done → return accumulated text + tool history
 *
 * No Vercel AI SDK. No hidden abstractions. Direct API calls.
 */

import { type ChatProvider, type ToolSchema, type StepResult } from './providers';
import { getToolsForAgent, executeTool, type ToolContext, type ToolInput } from './tools/registry';
import type { ToolResult } from '@/types/agent';
import { bus } from '../bus';
import { AGENT_DEFS, type AgentType } from './agents/types';

const DOOM_LOOP_THRESHOLD = 3;
const MAX_TOOL_OUTPUT_LENGTH = 8000;

// ── Public Types ─────────────────────────────────────────────────────

export interface AgentResult {
    response: string;
    toolCalls: Array<{
        id: string;
        name: string;
        input: Record<string, unknown>;
        result: ToolResult;
    }>;
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
}

// ── Main Loop ────────────────────────────────────────────────────────

export async function runAgentLoop(params: LoopParams): Promise<AgentResult> {
    const { provider, systemPrompt, userMessage, agentType, toolCtx, callbacks } = params;
    const agentDef = AGENT_DEFS[agentType];
    const maxSteps = params.maxIterations ?? agentDef.maxIterations;
    const shouldForceFirst = agentDef.forceFirstTool && !params.skipForceFirstTool;

    // Build tool schemas for this agent type
    const agentTools = getToolsForAgent(agentType);
    const filteredTools = agentTools.filter(t => !agentDef.deniedTools.includes(t.name));
    const toolSchemas: ToolSchema[] = filteredTools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
    }));

    const fullSystemPrompt = systemPrompt + '\n' + agentDef.systemSuffix;

    // Build initial messages
    const history = params.historyMessages ?? [];
    let messages = provider.buildMessages(history, userMessage);

    const allToolCalls: AgentResult['toolCalls'] = [];
    const recentCalls: Array<{ name: string; input: string }> = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let accumulatedText = '';
    let stepCount = 0;

    console.log(`[Loop] Starting: agent=${agentType} provider=${provider.id} maxSteps=${maxSteps} tools=${toolSchemas.length}`);

    while (stepCount < maxSteps) {
        stepCount++;
        callbacks.onIteration?.(stepCount);
        bus.emit('iteration.start', { iteration: stepCount });

        const forceToolUse = shouldForceFirst && stepCount === 1;

        console.log(`[Loop] Step ${stepCount}/${maxSteps} forceTools=${forceToolUse}`);

        let stepResult: StepResult;
        try {
            stepResult = await provider.chat({
                system: fullSystemPrompt,
                messages,
                tools: toolSchemas,
                maxTokens: 4096,
                temperature: 0.3,
                forceToolUse,
                callbacks: {
                    onText: (text) => {
                        accumulatedText += text;
                        callbacks.onText?.(text);
                    },
                    onReasoning: callbacks.onReasoning,
                },
            });
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`[Loop] Step ${stepCount} failed:`, errMsg);
            throw new Error(`Agent step ${stepCount} failed: ${errMsg}`);
        }

        totalInputTokens += stepResult.usage.inputTokens;
        totalOutputTokens += stepResult.usage.outputTokens;

        console.log(`[Loop] Step ${stepCount}: text=${stepResult.text.length}ch tools=${stepResult.toolCalls.length} done=${stepResult.done}`);

        // No tool calls → model is done
        if (stepResult.toolCalls.length === 0 || stepResult.done) {
            break;
        }

        // Execute tool calls
        const toolResults: Array<{ callId: string; output: string }> = [];

        for (const tc of stepResult.toolCalls) {
            // Doom loop detection
            const inputStr = JSON.stringify(tc.input);
            if (isDoomLoop(recentCalls, tc.name, inputStr)) {
                console.warn(`[Loop] Doom loop detected: ${tc.name}`);
                bus.emit('doom_loop.detected', { toolName: tc.name, count: DOOM_LOOP_THRESHOLD });
                toolResults.push({
                    callId: tc.id,
                    output: JSON.stringify({ error: `Tool "${tc.name}" called repeatedly with same input. Try a different approach.` }),
                });
                continue;
            }
            recentCalls.push({ name: tc.name, input: inputStr });
            if (recentCalls.length > DOOM_LOOP_THRESHOLD * 2) {
                recentCalls.splice(0, recentCalls.length - DOOM_LOOP_THRESHOLD * 2);
            }

            // Emit tool start
            callbacks.onToolStart?.(tc.name, tc.input, tc.id);

            // Execute
            toolCtx.createdFiles = [];
            const result = await executeTool(tc.name, tc.input as ToolInput, toolCtx);
            result.callId = tc.id;

            // Emit tool result
            callbacks.onToolResult?.(tc.name, result);

            // Track
            allToolCalls.push({ id: tc.id, name: tc.name, input: tc.input, result });

            // Truncate output for context
            let output = typeof result.output === 'string'
                ? result.output
                : JSON.stringify(result.output);
            if (output.length > MAX_TOOL_OUTPUT_LENGTH) {
                output = output.slice(0, MAX_TOOL_OUTPUT_LENGTH) + '\n...[truncated]';
            }
            if (result.error) {
                output = JSON.stringify({ error: result.error });
            }

            toolResults.push({ callId: tc.id, output });
        }

        // Append assistant response + tool results to messages
        messages = provider.appendToolResults(messages, stepResult, toolResults);
    }

    const response = accumulatedText || 'Done.';
    const totalTokens = totalInputTokens + totalOutputTokens;

    console.log(`[Loop] Complete: steps=${stepCount} tools=${allToolCalls.length} tokens=${totalTokens} text=${accumulatedText.length}ch`);

    return {
        response,
        toolCalls: allToolCalls,
        totalTokens,
        iterations: stepCount,
    };
}

// ── Helpers ──────────────────────────────────────────────────────────

function isDoomLoop(
    recentCalls: Array<{ name: string; input: string }>,
    currentName: string,
    currentInput: string,
): boolean {
    if (recentCalls.length < DOOM_LOOP_THRESHOLD - 1) return false;
    const last = recentCalls.slice(-(DOOM_LOOP_THRESHOLD - 1));
    return last.every(call => call.name === currentName && call.input === currentInput);
}
