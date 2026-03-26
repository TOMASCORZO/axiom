/**
 * Agent Loop — OpenCode-faithful processGeneration.
 *
 * Key OpenCode patterns implemented:
 * - Doom loop detection: if the same tool+input is called 3x in a row, stop
 * - Tool repair: lowercase fallback for misnamed tools
 * - Max steps with summary request
 * - Feedback loop: every tool result goes back to the LLM
 * - Step tracking with callbacks for SSE streaming
 */

import type { ToolResult, ToolFileData } from '@/types/agent';
import type { ProviderAdapter, ProviderConfig, ProviderMessage, ProviderTool } from '../providers/base';
import { executeTool, getToolSchemas, type ToolContext } from '../tools';
import { AGENT_DEFS, type AgentType } from './types';

const DOOM_LOOP_THRESHOLD = 3;

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
    onToolStart?: (toolName: string, input: Record<string, unknown>) => void;
    onToolResult?: (toolName: string, result: ToolResult) => void;
    onIteration?: (iteration: number) => void;
    onReasoning?: (reasoning: string) => void;
    onText?: (text: string) => void;
}

export interface LoopParams {
    adapter: ProviderAdapter;
    config: ProviderConfig;
    systemPrompt: string;
    userMessage: string;
    agentType: AgentType;
    toolCtx: ToolContext;
    callbacks: LoopCallbacks;
    historyMessages?: ProviderMessage[];
}

/**
 * Detect doom loop — OpenCode pattern.
 * If the last N tool calls have the same name AND same input, it's a doom loop.
 */
function isDoomLoop(
    recentCalls: Array<{ name: string; input: Record<string, unknown> }>,
    currentName: string,
    currentInput: Record<string, unknown>,
): boolean {
    if (recentCalls.length < DOOM_LOOP_THRESHOLD - 1) return false;

    const inputStr = JSON.stringify(currentInput);
    const last = recentCalls.slice(-(DOOM_LOOP_THRESHOLD - 1));

    return last.every(
        call => call.name === currentName && JSON.stringify(call.input) === inputStr,
    );
}

/**
 * processGeneration — the heart of the agent.
 * Runs the ReAct loop until completion, doom loop, or max iterations.
 */
export async function processGeneration(params: LoopParams): Promise<AgentResult> {
    const { adapter, config, systemPrompt, userMessage, agentType, toolCtx, callbacks } = params;
    const agentDef = AGENT_DEFS[agentType];

    const toolDefs = getToolSchemas(agentType);
    const tools: ProviderTool[] = toolDefs.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
    }));

    const fullSystemPrompt = systemPrompt + '\n' + agentDef.systemSuffix;

    const messages: ProviderMessage[] = [
        { role: 'system', content: fullSystemPrompt },
        ...(params.historyMessages ?? []),
        { role: 'user', content: userMessage },
    ];

    const allToolCalls: AgentResult['toolCalls'] = [];
    const recentCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
    let totalTokens = 0;
    let iterations = 0;

    for (let i = 0; i < agentDef.maxIterations; i++) {
        iterations = i + 1;
        callbacks.onIteration?.(iterations);

        // On last iteration, tell the LLM to wrap up (OpenCode max-steps pattern)
        if (i === agentDef.maxIterations - 1) {
            messages.push({
                role: 'user',
                content: `[SYSTEM] You have reached the maximum number of steps (${agentDef.maxIterations}). Please provide a summary of what you accomplished and what remains to be done. Do not make any more tool calls.`,
            });
        }

        const response = await adapter.chat(
            config,
            messages,
            i === agentDef.maxIterations - 1 ? [] : tools, // No tools on last iteration
            (i === 0 && agentDef.forceFirstTool) ? 'required' : 'auto',
        );

        totalTokens += response.usage.inputTokens + response.usage.outputTokens;

        if (response.reasoning) {
            callbacks.onReasoning?.(response.reasoning);
        }

        if (response.content) {
            callbacks.onText?.(response.content);
        }

        const assistantMsg: ProviderMessage = {
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
            reasoning: response.reasoning ?? undefined,
        };
        messages.push(assistantMsg);

        // If no tool calls → done
        if (response.toolCalls.length === 0 || response.finishReason === 'stop' || response.finishReason === 'length') {
            return {
                response: response.content || response.reasoning || 'Done.',
                toolCalls: allToolCalls,
                totalTokens,
                iterations,
            };
        }

        // Execute each tool call with doom loop detection
        for (const tc of response.toolCalls) {
            let toolInput: Record<string, unknown> = {};
            try { toolInput = JSON.parse(tc.arguments); } catch { /* */ }

            // Doom loop detection (OpenCode pattern)
            if (isDoomLoop(recentCalls, tc.name, toolInput)) {
                const errorMsg = `Doom loop detected: tool "${tc.name}" called ${DOOM_LOOP_THRESHOLD} times with identical input. Stopping to prevent infinite loop.`;
                callbacks.onToolResult?.(tc.name, {
                    callId: tc.id,
                    success: false,
                    output: {},
                    filesModified: [],
                    error: errorMsg,
                    duration_ms: 0,
                });
                messages.push({
                    role: 'tool',
                    content: JSON.stringify({ error: errorMsg, hint: 'You are repeating the same action. Try a different approach or provide your final answer.' }),
                    toolCallId: tc.id,
                });
                continue;
            }

            callbacks.onToolStart?.(tc.name, toolInput);

            const result = await executeTool(tc.name, toolInput, toolCtx);
            result.callId = tc.id;

            callbacks.onToolResult?.(tc.name, result);

            allToolCalls.push({ id: tc.id, name: tc.name, input: toolInput, result });
            recentCalls.push({ name: tc.name, input: toolInput });

            // Keep only recent calls for doom loop detection
            if (recentCalls.length > DOOM_LOOP_THRESHOLD * 2) {
                recentCalls.splice(0, recentCalls.length - DOOM_LOOP_THRESHOLD * 2);
            }

            // Feed result back to LLM — the key feedback loop
            const resultContent = result.success
                ? JSON.stringify(result.output)
                : JSON.stringify({ error: result.error, hint: 'The tool failed. Read the error carefully and try a different approach.' });

            messages.push({
                role: 'tool',
                content: resultContent,
                toolCallId: tc.id,
            });
        }
    }

    const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
    return {
        response: lastAssistant?.content || 'Agent reached maximum iterations.',
        toolCalls: allToolCalls,
        totalTokens,
        iterations,
    };
}

/**
 * Run a subagent — creates a nested agent loop with its own context.
 * OpenCode pattern: Task tool spawns child sessions.
 */
export async function runSubagent(params: {
    adapter: ProviderAdapter;
    config: ProviderConfig;
    systemPrompt: string;
    task: string;
    agentType: AgentType;
    toolCtx: ToolContext;
}): Promise<string> {
    const result = await processGeneration({
        adapter: params.adapter,
        config: params.config,
        systemPrompt: params.systemPrompt,
        userMessage: params.task,
        agentType: params.agentType,
        toolCtx: params.toolCtx,
        callbacks: {},
    });
    return result.response;
}
