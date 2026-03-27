/**
 * AI SDK Agent Loop — OpenCode-faithful streamText() implementation.
 *
 * Uses fullStream (like OpenCode's processor.ts) to handle ALL stream events:
 * text-delta, tool-call, tool-result, step-finish, etc.
 *
 * Key OpenCode patterns:
 * - Doom loop detection (same tool+input called 3x)
 * - Tool repair via experimental_repairToolCall
 * - Max steps via stopWhen + stepCountIs
 * - Dynamic toolChoice via prepareStep (required on first, auto after)
 * - fullStream consumption (handles text AND tool-only responses)
 */

import { streamText, stepCountIs, NoOutputGeneratedError } from 'ai';
import type { LanguageModel } from 'ai';
import { buildToolSet, type ToolCallbacks } from './ai-tools';
import type { ToolContext } from './tools/registry';
import type { ToolResult } from '@/types/agent';
import { bus } from '../bus';
import { AGENT_DEFS, type AgentType } from './agents/types';

const DOOM_LOOP_THRESHOLD = 3;

/** Extract the deepest cause from an error chain */
function getRootCause(error: unknown): string {
    const messages: string[] = [];
    let current: unknown = error;
    let depth = 0;
    while (current instanceof Error && depth < 5) {
        messages.push(`${current.constructor.name}: ${current.message}`);
        current = current.cause;
        depth++;
    }
    return messages.join(' → ');
}

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
    /** Provider ID — used to disable unsupported features (e.g. toolChoice for Kimi) */
    provider?: string;
}

export async function runAILoop(params: AILoopParams): Promise<AgentResult> {
    const { model, systemPrompt, userMessage, agentType, toolCtx, callbacks } = params;
    const agentDef = AGENT_DEFS[agentType];
    const maxSteps = params.maxIterations ?? agentDef.maxIterations;
    // Only force toolChoice on providers known to support it
    const TOOL_CHOICE_PROVIDERS = ['claude', 'gpt', 'gemini'];
    const providerSupportsToolChoice = !params.provider || TOOL_CHOICE_PROVIDERS.includes(params.provider);
    const shouldForceFirst = agentDef.forceFirstTool && !params.skipForceFirstTool && providerSupportsToolChoice;

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
    const toolCount = Object.keys(tools).length - 1; // minus 'invalid'

    // Track stream-level errors so we can surface them if NoOutputGeneratedError fires
    const streamErrors: string[] = [];

    console.log(`[AI Loop] Starting: agent=${agentType} provider=${params.provider ?? 'unknown'} maxSteps=${maxSteps} forceFirst=${shouldForceFirst} tools=${toolCount}`);

    try {
        const result = streamText({
            model,
            system: fullSystemPrompt,
            messages,
            tools,
            stopWhen: stepCountIs(maxSteps),

            // Dynamic toolChoice per step — only force on first step
            prepareStep({ stepNumber }) {
                if (stepNumber === 0 && shouldForceFirst) {
                    return { toolChoice: 'required' as const };
                }
                return { toolChoice: 'auto' as const };
            },

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
                const rootCause = getRootCause(event.error);
                streamErrors.push(rootCause);
                console.error('[AI Loop] Stream error:', rootCause);
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

                // Doom loop detection
                if (event.toolCalls) {
                    for (const tc of event.toolCalls) {
                        const inputStr = JSON.stringify((tc as any).input);
                        if (isDoomLoop(recentCalls, tc.toolName, inputStr)) {
                            bus.emit('doom_loop.detected', { toolName: tc.toolName, count: DOOM_LOOP_THRESHOLD });
                            console.warn(`[AI Loop] Doom loop: ${tc.toolName}`);
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

                console.log(`[AI Loop] Step ${stepCount}: text=${event.text?.length || 0}ch tools=${event.toolCalls?.length || 0} finish=${event.finishReason}`);
            },
        });

        // KEY FIX: Use fullStream instead of textStream.
        // textStream throws NoContentGeneratedError when the model only makes
        // tool calls without text. fullStream handles ALL event types safely.
        for await (const part of result.fullStream) {
            switch (part.type) {
                case 'text-delta':
                    // Incremental text — stream to client immediately
                    accumulatedText += part.text;
                    callbacks.onText?.(part.text);
                    bus.emit('model.text', { text: part.text });
                    break;

                case 'reasoning-delta':
                    // Extended thinking tokens
                    if (part.text) {
                        accumulatedReasoning += part.text;
                        callbacks.onReasoning?.(part.text);
                        bus.emit('model.reasoning', { text: part.text });
                    }
                    break;

                case 'error':
                    streamErrors.push(getRootCause(part.error));
                    console.error('[AI Loop] Stream part error:', getRootCause(part.error));
                    break;

                // tool-call, tool-result, step-finish etc. are handled by
                // onStepFinish callback above — we just need to consume them
                default:
                    break;
            }
        }

        // Get final usage after stream is fully consumed
        const finalUsage = await result.usage;
        if (finalUsage) {
            totalTokens = (finalUsage.inputTokens ?? 0) + (finalUsage.outputTokens ?? 0);
        }

        const response = accumulatedText || accumulatedReasoning || 'Done.';

        console.log(`[AI Loop] Complete: steps=${stepCount} tools=${allToolCalls.length} tokens=${totalTokens} text=${accumulatedText.length}ch`);

        return {
            response,
            toolCalls: allToolCalls,
            totalTokens,
            iterations: Math.max(stepCount, 1),
        };

    } catch (error) {
        const errName = error instanceof Error ? error.constructor.name : 'Unknown';
        const rootCause = getRootCause(error);
        const streamCtx = streamErrors.length > 0 ? ` | Stream errors: ${streamErrors.join('; ')}` : '';
        const fullError = `${rootCause}${streamCtx}`;
        console.error(`[AI Loop] Fatal: ${fullError}`);

        // NoOutputGeneratedError means the model returned nothing — surface the real cause
        if (NoOutputGeneratedError.isInstance(error)) {
            const hint = streamErrors.length > 0
                ? streamErrors.join('; ')
                : 'Model returned empty response. Check API key, model ID, and rate limits.';
            console.error(`[AI Loop] NoOutputGeneratedError cause: ${hint}`);

            // Return partial results if we have any
            if (allToolCalls.length > 0 || accumulatedText) {
                return {
                    response: accumulatedText || `Agent completed with warnings: ${hint}`,
                    toolCalls: allToolCalls,
                    totalTokens,
                    iterations: Math.max(stepCount, 1),
                };
            }

            throw new Error(`AI model produced no output. Cause: ${hint}`);
        }

        // Return partial results for other errors
        if (allToolCalls.length > 0 || accumulatedText) {
            return {
                response: accumulatedText || `Agent error: ${fullError}. ${allToolCalls.length} tools executed before failure.`,
                toolCalls: allToolCalls,
                totalTokens,
                iterations: Math.max(stepCount, 1),
            };
        }

        throw new Error(`AI Loop failed (${errName}): ${fullError}`);
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
