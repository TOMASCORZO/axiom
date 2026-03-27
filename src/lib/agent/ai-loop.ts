/**
 * AI SDK Agent Loop — OpenCode-faithful streamText() implementation.
 *
 * Uses the Vercel AI SDK's streamText() which handles tool call parsing,
 * execution, and feedback automatically.
 *
 * Key OpenCode patterns:
 * - Doom loop detection (same tool+input called 3x)
 * - Tool repair via experimental_repairToolCall
 * - Max steps via stopWhen + stepCountIs
 * - Dynamic toolChoice via prepareStep (required on first, auto after)
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

export async function runAILoop(params: AILoopParams): Promise<AgentResult> {
    const { model, systemPrompt, userMessage, agentType, toolCtx, callbacks } = params;
    const agentDef = AGENT_DEFS[agentType];
    const maxSteps = params.maxIterations ?? agentDef.maxIterations;
    const shouldForceFirst = agentDef.forceFirstTool && !params.skipForceFirstTool;

    const tools = buildToolSet(agentType, toolCtx, callbacks, agentDef.deniedTools);

    const allToolCalls: AgentResult['toolCalls'] = [];
    const recentCalls: Array<{ name: string; input: string }> = [];
    let totalTokens = 0;
    let stepCount = 0;
    let accumulatedText = '';
    let accumulatedReasoning = '';

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (params.historyMessages?.length) {
        messages.push(...params.historyMessages);
    }
    messages.push({ role: 'user', content: userMessage });

    const fullSystemPrompt = systemPrompt + '\n' + agentDef.systemSuffix;

    console.log(`[AI Loop] Starting: agent=${agentType} maxSteps=${maxSteps} forceFirst=${shouldForceFirst} tools=${Object.keys(tools).length - 1}`);

    try {
        const result = streamText({
            model,
            system: fullSystemPrompt,
            messages,
            tools,
            stopWhen: stepCountIs(maxSteps),

            // FIX: Use prepareStep to set toolChoice dynamically per step.
            // Only force tool use on the first step (OpenCode pattern).
            // After that, use 'auto' so the model can respond with text when done.
            prepareStep({ stepNumber }) {
                if (stepNumber === 0 && shouldForceFirst) {
                    return { toolChoice: 'required' as const };
                }
                return { toolChoice: 'auto' as const };
            },

            // OpenCode pattern: repair misnamed tool calls
            experimental_repairToolCall: async (failed) => {
                const lower = failed.toolCall.toolName.toLowerCase();
                const toolNames = Object.keys(tools).filter(n => n !== 'invalid');

                if (lower !== failed.toolCall.toolName && tools[lower]) {
                    console.log(`[AI Loop] Repairing tool: ${failed.toolCall.toolName} → ${lower}`);
                    return { ...failed.toolCall, toolName: lower };
                }

                const prefixMatch = toolNames.find(n => n.toLowerCase() === lower);
                if (prefixMatch) {
                    console.log(`[AI Loop] Repairing tool: ${failed.toolCall.toolName} → ${prefixMatch}`);
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

                if (event.usage) {
                    totalTokens += (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0);
                    bus.emit('model.tokens', {
                        inputTokens: event.usage.inputTokens ?? 0,
                        outputTokens: event.usage.outputTokens ?? 0,
                    });
                }

                // Doom loop detection on tool calls
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

                // Collect tool results
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

                // Emit text (fires once per step with full step text)
                if (event.text) {
                    accumulatedText += event.text;
                    callbacks.onText?.(event.text);
                    bus.emit('model.text', { text: event.text });
                }

                // Emit reasoning
                if (event.reasoningText) {
                    accumulatedReasoning += event.reasoningText;
                    callbacks.onReasoning?.(event.reasoningText);
                    bus.emit('model.reasoning', { text: event.reasoningText });
                }

                console.log(`[AI Loop] Step ${stepCount}: text=${event.text?.length || 0}ch toolCalls=${event.toolCalls?.length || 0} finish=${event.finishReason}`);
            },
        });

        // FIX: Consume the stream incrementally to ensure callbacks fire.
        // result.text is a promise that resolves when all streaming is done.
        // We also consume textStream to get incremental text chunks for real-time SSE.
        const textChunks: string[] = [];
        for await (const chunk of result.textStream) {
            textChunks.push(chunk);
        }

        // Now get final usage (stream is fully consumed at this point)
        const finalUsage = await result.usage;

        if (finalUsage) {
            totalTokens = (finalUsage.inputTokens ?? 0) + (finalUsage.outputTokens ?? 0);
        }

        // Use the accumulated text from textStream if onStepFinish didn't capture it
        const streamedText = textChunks.join('');
        if (streamedText && !accumulatedText) {
            accumulatedText = streamedText;
            callbacks.onText?.(streamedText);
            bus.emit('model.text', { text: streamedText });
        }

        const response = accumulatedText || accumulatedReasoning || 'Done.';

        console.log(`[AI Loop] Complete: steps=${stepCount} tools=${allToolCalls.length} tokens=${totalTokens} response=${response.length}ch`);

        return {
            response,
            toolCalls: allToolCalls,
            totalTokens,
            iterations: Math.max(stepCount, 1),
        };

    } catch (error) {
        console.error('[AI Loop] Fatal error:', error);

        // Return partial results if we have any
        if (allToolCalls.length > 0 || accumulatedText) {
            return {
                response: accumulatedText || `Agent error: ${error instanceof Error ? error.message : 'Unknown error'}. Partial results: ${allToolCalls.length} tools executed.`,
                toolCalls: allToolCalls,
                totalTokens,
                iterations: Math.max(stepCount, 1),
            };
        }

        // Re-throw with more context for the SSE error handler
        throw new Error(`AI Loop failed: ${error instanceof Error ? error.message : String(error)}`);
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
