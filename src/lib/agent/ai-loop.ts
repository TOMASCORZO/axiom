/**
 * AI SDK Agent Loop — OpenCode-faithful streamText() implementation.
 *
 * This replaces the manual ReAct loop with the Vercel AI SDK's streamText(),
 * which handles tool call parsing, execution, and feedback automatically.
 *
 * Key OpenCode patterns ported:
 * - Doom loop detection (same tool+input called 3x)
 * - Tool repair via experimental_repairToolCall
 * - Max steps via stopWhen + stepCountIs
 * - Streaming callbacks for SSE events
 * - Output truncation (handled in ai-tools.ts)
 */

import { streamText, stepCountIs } from 'ai';
import type { LanguageModel } from 'ai';
import { buildToolSet, type ToolCallbacks } from './ai-tools';
import type { ToolContext } from './tools/registry';
import type { ToolResult } from '@/types/agent';
import { bus } from '../bus';
import { AGENT_DEFS, type AgentType } from './agents/types';

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

export interface AILoopCallbacks extends ToolCallbacks {
    onIteration?: (iteration: number) => void;
    onReasoning?: (reasoning: string) => void;
    onText?: (text: string) => void;
}

export interface AILoopParams {
    model: LanguageModel;
    systemPrompt: string;
    userMessage: string;
    agentType: AgentType;
    toolCtx: ToolContext;
    callbacks: AILoopCallbacks;
    historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
    skipForceFirstTool?: boolean;
    maxIterations?: number;
}

/**
 * Run the AI agent loop using streamText().
 *
 * The AI SDK handles:
 * - Tool call parsing per provider
 * - Tool execution via the execute() functions
 * - Tool result injection back into the conversation
 * - Multi-step tool use (stopWhen + stepCountIs)
 * - Streaming of text and reasoning tokens
 *
 * We handle:
 * - Doom loop detection
 * - SSE event emission
 * - Tool repair
 * - Result aggregation
 */
export async function runAILoop(params: AILoopParams): Promise<AgentResult> {
    const { model, systemPrompt, userMessage, agentType, toolCtx, callbacks } = params;
    const agentDef = AGENT_DEFS[agentType];
    const maxSteps = params.maxIterations ?? agentDef.maxIterations;
    const shouldForceFirst = agentDef.forceFirstTool && !params.skipForceFirstTool;

    // Build the tool set from registered tools
    const tools = buildToolSet(agentType, toolCtx, callbacks, agentDef.deniedTools);

    // Track tool calls for doom loop detection and result aggregation
    const allToolCalls: AgentResult['toolCalls'] = [];
    const recentCalls: Array<{ name: string; input: string }> = [];
    let totalTokens = 0;
    let stepCount = 0;
    let accumulatedText = '';
    let accumulatedReasoning = '';

    // Build message history
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    // History messages (previous conversation)
    if (params.historyMessages?.length) {
        messages.push(...params.historyMessages);
    }

    // Current user message
    messages.push({ role: 'user', content: userMessage });

    // Build full system prompt
    const fullSystemPrompt = systemPrompt + '\n' + agentDef.systemSuffix;

    console.log(`[AI Loop] Starting: agent=${agentType} maxSteps=${maxSteps} forceFirst=${shouldForceFirst} tools=${Object.keys(tools).length - 1}`);

    try {
        const result = streamText({
            model,
            system: fullSystemPrompt,
            messages,
            tools,
            stopWhen: stepCountIs(maxSteps),
            toolChoice: shouldForceFirst ? 'required' : 'auto',

            // OpenCode pattern: repair misnamed tool calls
            experimental_repairToolCall: async (failed) => {
                const lower = failed.toolCall.toolName.toLowerCase();
                const toolNames = Object.keys(tools).filter(n => n !== 'invalid');

                if (lower !== failed.toolCall.toolName && tools[lower]) {
                    console.log(`[AI Loop] Repairing tool call: ${failed.toolCall.toolName} → ${lower}`);
                    return { ...failed.toolCall, toolName: lower };
                }

                const prefixMatch = toolNames.find(n => n.toLowerCase() === lower);
                if (prefixMatch) {
                    console.log(`[AI Loop] Repairing tool call: ${failed.toolCall.toolName} → ${prefixMatch}`);
                    return { ...failed.toolCall, toolName: prefixMatch };
                }

                return {
                    ...failed.toolCall,
                    input: JSON.stringify({
                        tool: failed.toolCall.toolName,
                        error: failed.error.message,
                    }),
                    toolName: 'invalid',
                };
            },

            maxOutputTokens: 4096,
            temperature: 0.3,

            onError(event) {
                console.error('[AI Loop] Stream error:', event.error);
            },

            onStepFinish(event) {
                stepCount++;
                callbacks.onIteration?.(stepCount);
                bus.emit('iteration.start', { iteration: stepCount });

                // Track token usage (AI SDK v6: inputTokens/outputTokens)
                if (event.usage) {
                    totalTokens += (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0);
                    bus.emit('model.tokens', {
                        inputTokens: event.usage.inputTokens ?? 0,
                        outputTokens: event.usage.outputTokens ?? 0,
                    });
                }

                // Collect tool calls from this step (AI SDK v6: tc.input not tc.args)
                if (event.toolCalls) {
                    for (const tc of event.toolCalls) {
                        const inputStr = JSON.stringify((tc as any).input);

                        if (isDoomLoop(recentCalls, tc.toolName, inputStr)) {
                            bus.emit('doom_loop.detected', { toolName: tc.toolName, count: DOOM_LOOP_THRESHOLD });
                            console.warn(`[AI Loop] Doom loop detected: ${tc.toolName}`);
                        }

                        recentCalls.push({ name: tc.toolName, input: inputStr });
                        if (recentCalls.length > DOOM_LOOP_THRESHOLD * 2) {
                            recentCalls.splice(0, recentCalls.length - DOOM_LOOP_THRESHOLD * 2);
                        }
                    }
                }

                // Collect tool results from this step (AI SDK v6: tr.output not tr.result)
                if (event.toolResults) {
                    for (const tr of event.toolResults) {
                        const tc = event.toolCalls?.find((c: any) => c.toolCallId === tr.toolCallId);
                        if (tc && tc.toolName !== 'invalid') {
                            allToolCalls.push({
                                id: tr.toolCallId,
                                name: tc.toolName,
                                input: (tc as any).input as Record<string, unknown>,
                                result: {
                                    callId: tr.toolCallId,
                                    success: !String((tr as any).output).startsWith('{"error"'),
                                    output: (tr as any).output,
                                    filesModified: [],
                                    duration_ms: 0,
                                },
                            });
                        }
                    }
                }

                // Emit text if produced in this step
                if (event.text) {
                    accumulatedText += event.text;
                    callbacks.onText?.(event.text);
                    bus.emit('model.text', { text: event.text });
                }

                // Emit reasoning if present (AI SDK v6: reasoningText is string | undefined)
                if (event.reasoningText) {
                    accumulatedReasoning += event.reasoningText;
                    callbacks.onReasoning?.(event.reasoningText);
                    bus.emit('model.reasoning', { text: event.reasoningText });
                }

                console.log(`[AI Loop] Step ${stepCount}: text=${event.text?.length || 0}ch toolCalls=${event.toolCalls?.length || 0} finish=${event.finishReason}`);
            },
        });

        // Wait for the full stream to complete
        const finalText = await result.text;
        const finalUsage = await result.usage;

        if (finalUsage) {
            totalTokens = (finalUsage.inputTokens ?? 0) + (finalUsage.outputTokens ?? 0);
        }

        if (finalText && finalText !== accumulatedText) {
            accumulatedText = finalText;
        }

        const response = accumulatedText || accumulatedReasoning || 'Done.';

        console.log(`[AI Loop] Complete: steps=${stepCount} tools=${allToolCalls.length} tokens=${totalTokens} response=${response.length}ch`);

        return {
            response,
            toolCalls: allToolCalls,
            totalTokens,
            iterations: stepCount,
        };

    } catch (error) {
        console.error('[AI Loop] Fatal error:', error);

        if (allToolCalls.length > 0 || accumulatedText) {
            return {
                response: accumulatedText || `Agent error: ${error instanceof Error ? error.message : 'Unknown error'}. Partial results: ${allToolCalls.length} tools executed.`,
                toolCalls: allToolCalls,
                totalTokens,
                iterations: stepCount,
            };
        }

        throw error;
    }
}

function isDoomLoop(
    recentCalls: Array<{ name: string; input: string }>,
    currentName: string,
    currentInput: string,
): boolean {
    if (recentCalls.length < DOOM_LOOP_THRESHOLD - 1) return false;
    const last = recentCalls.slice(-(DOOM_LOOP_THRESHOLD - 1));
    return last.every(
        call => call.name === currentName && call.input === currentInput,
    );
}
