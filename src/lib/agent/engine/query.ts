import { StreamEvent, Message, AssistantMessage, ToolUseBlock, ToolResultBlock } from '../../../types/agent';
import { ChatProvider, ToolSchema } from '../providers';
import { executeTool, getTool, ToolContext, ToolInput, PermissionMode } from '../tools/registry';
import { microcompactMessages } from '../services/microcompact';
import { autoCompactIfNeeded } from '../services/autoCompact';
import { snipCompact } from '../services/snip';
import { randomUUID } from 'crypto';
import { runPreToolHooks, runPostToolHooks } from '../hooks';

export interface QueryOptions {
    maxTokens: number;
    provider: ChatProvider;
    systemPrompt: string;
    tools: ToolSchema[];
    toolCtx: ToolContext;
    maxIterations?: number;
    permissionMode?: PermissionMode;
    abortController?: AbortController;
    callbacks?: {
        onToolStart?: (toolName: string, input: Record<string, unknown>, callId: string) => void;
        onToolResult?: (toolName: string, result: any) => void;
        onIteration?: (i: number) => void;
    };
}

const MAX_TOOL_OUTPUT_LENGTH = 8000;
const MAX_API_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 3000, 8000];

function isRetryableError(error: string): boolean {
    const retryable = ['overloaded', 'rate_limit', '529', '503', '500', 'ECONNRESET', 'ETIMEDOUT'];
    return retryable.some(r => error.toLowerCase().includes(r.toLowerCase()));
}

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * queryLoop is the async generator that powers the agent interactions.
 * It manages context window limits, streams tokens, pauses to run tools,
 * and loops until the agent is done.
 *
 * CC patterns implemented:
 * - Retry on overloaded/rate-limit errors
 * - Parallel execution for concurrent-safe tools, sequential for unsafe ones
 * - AbortController integration
 * - Tool result budgeting via maxResultSizeChars
 * - Plan mode enforcement
 */
export async function* queryLoop(
    messages: Message[],
    options: QueryOptions
): AsyncGenerator<StreamEvent, { assistantMessage: AssistantMessage, newMessages: Message[], iterations: number }, unknown> {
    const { provider, systemPrompt, tools, toolCtx, callbacks } = options;
    const abortController = options.abortController ?? toolCtx.abortController;
    const permissionMode = options.permissionMode ?? 'default';
    let currentMessages = [...messages];
    let stepCount = 0;
    const maxIterations = options.maxIterations ?? 25;

    console.log(`[QueryLoop] Starting with ${tools.length} tools, max ${maxIterations} iterations`);
    let finalAssistantMsg: AssistantMessage | null = null;

    while (stepCount < maxIterations) {
        stepCount++;
        callbacks?.onIteration?.(stepCount);

        // Check abort
        if (abortController?.signal.aborted) {
            if (!finalAssistantMsg) {
                finalAssistantMsg = {
                    type: 'assistant', uuid: randomUUID(),
                    message: { content: [{ type: 'text', text: '[Aborted by user]' }], stop_reason: 'end_turn' }
                };
                currentMessages.push(finalAssistantMsg);
            }
            break;
        }

        // 1. Context Compression pipeline
        currentMessages = snipCompact(currentMessages, 20);
        currentMessages = microcompactMessages(currentMessages);
        const compactResult = await autoCompactIfNeeded(currentMessages, provider, 80000);
        if (compactResult.wasCompacted) {
            currentMessages = compactResult.messages;
        }

        // Force the model to use tools on the first iteration so it acts instead of just talking
        const forceToolUse = stepCount === 1 && tools.length > 0;

        // 2. Initiate Model Stream (with retry logic)
        let assistantMsg: AssistantMessage | null = null;

        for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
            assistantMsg = {
                type: 'assistant',
                uuid: randomUUID(),
                message: { content: [] }
            };

            let currentText = '';
            let currentTool: ToolUseBlock | null = null;
            let rawJsonAccumulator = '';
            let apiError: string | null = null;

            try {
                const stream = provider.chat({
                    system: systemPrompt,
                    messages: currentMessages,
                    tools,
                    maxTokens: options.maxTokens,
                    temperature: 0.2,
                    forceToolUse,
                });

                for await (const chunk of stream) {
                    // Check abort during streaming
                    if (abortController?.signal.aborted) {
                        apiError = 'Aborted';
                        break;
                    }

                    yield chunk;

                    if (chunk.type === 'content_block_start') {
                        if (chunk.block.type === 'tool_use') {
                            currentTool = { type: 'tool_use', id: chunk.block.id, name: chunk.block.name, input: {} };
                            rawJsonAccumulator = '';
                        }
                    } else if (chunk.type === 'content_block_delta') {
                        if ('text' in chunk.delta && chunk.delta.type === 'text_delta') {
                            if (!currentTool) currentText += chunk.delta.text;
                        } else if ('partial_json' in chunk.delta) {
                            if (currentTool) rawJsonAccumulator += chunk.delta.partial_json;
                        }
                    } else if (chunk.type === 'content_block_stop') {
                        if (currentTool) {
                            try {
                                currentTool.input = JSON.parse(rawJsonAccumulator || '{}');
                            } catch (e) {
                                console.warn(`[QueryEngine] Failed to parse tool input for ${currentTool.name}:`, (e as Error).message);
                                currentTool.input = { _raw_parse_error: true, _raw: rawJsonAccumulator };
                            }
                            assistantMsg.message.content.push(currentTool);
                            currentTool = null;
                        } else if (currentText) {
                            assistantMsg.message.content.push({ type: 'text', text: currentText });
                            currentText = '';
                        }
                    } else if (chunk.type === 'message_delta') {
                        if (chunk.stop_reason) assistantMsg.message.stop_reason = chunk.stop_reason;
                    } else if (chunk.type === 'error') {
                        apiError = chunk.error.message;
                    }
                }
            } catch (e: any) {
                apiError = e.message || String(e);
            }

            // Flush remaining text
            if (currentText) assistantMsg.message.content.push({ type: 'text', text: currentText });

            // If error is retryable, back off and retry
            if (apiError && isRetryableError(apiError) && attempt < MAX_API_RETRIES) {
                const backoff = RETRY_BACKOFF_MS[attempt] ?? 8000;
                console.warn(`[QueryEngine] Retryable API error (attempt ${attempt + 1}/${MAX_API_RETRIES}): ${apiError}. Retrying in ${backoff}ms...`);
                await sleep(backoff);
                continue;
            }

            if (apiError) {
                assistantMsg.apiError = apiError;
                console.error(`[QueryEngine] API error after ${attempt + 1} attempts: ${apiError}`);
            }

            break; // Success or non-retryable error
        }

        if (!assistantMsg) {
            throw new Error('Query loop failed to produce an assistant message');
        }

        currentMessages.push(assistantMsg);
        finalAssistantMsg = assistantMsg;

        if (assistantMsg.apiError) break;

        // 3. Execute Tools — parallel for concurrent-safe, sequential for unsafe
        const toolUses = assistantMsg.message.content.filter(b => b.type === 'tool_use') as ToolUseBlock[];
        console.log(`[QueryLoop] Step ${stepCount}: ${toolUses.length} tool calls, stop_reason=${assistantMsg.message.stop_reason}`);
        if (toolUses.length === 0) break;

        // Partition into concurrent-safe and unsafe
        const concurrentSafe: ToolUseBlock[] = [];
        const sequential: ToolUseBlock[] = [];

        for (const tu of toolUses) {
            const toolDef = getTool(tu.name);
            if (toolDef?.isConcurrencySafe) {
                concurrentSafe.push(tu);
            } else {
                sequential.push(tu);
            }
        }

        const allResults: ToolResultBlock[] = [];

        // Run concurrent-safe tools in parallel
        if (concurrentSafe.length > 0) {
            const parallelResults = await Promise.all(
                concurrentSafe.map(tu => executeToolCall(tu, toolCtx, permissionMode, callbacks))
            );
            allResults.push(...parallelResults);
        }

        // Run unsafe tools sequentially
        for (const tu of sequential) {
            if (abortController?.signal.aborted) {
                allResults.push({
                    type: 'tool_result', tool_use_id: tu.id,
                    content: '[Aborted by user]', is_error: true
                });
                continue;
            }
            const result = await executeToolCall(tu, toolCtx, permissionMode, callbacks);
            allResults.push(result);
        }

        // Sort results back to original tool_use order
        const orderedResults: ToolResultBlock[] = toolUses.map(tu =>
            allResults.find(r => r.tool_use_id === tu.id)!
        );

        currentMessages.push({
            type: 'user',
            uuid: randomUUID(),
            message: { content: orderedResults }
        });

        // Stop if the model signaled end
        const stopReason = assistantMsg.message.stop_reason;
        if (stopReason === 'end_turn' || stopReason === 'stop') break;
    }

    return {
        assistantMessage: finalAssistantMsg!,
        newMessages: currentMessages,
        iterations: stepCount
    };
}

/**
 * Execute a single tool call and return a ToolResultBlock.
 */
async function executeToolCall(
    tu: ToolUseBlock,
    toolCtx: ToolContext,
    permissionMode: PermissionMode,
    callbacks?: QueryOptions['callbacks']
): Promise<ToolResultBlock> {
    const hookCtx = { projectId: toolCtx.projectId, userId: toolCtx.userId };

    // Pre-tool hooks: can block or modify input
    const preResult = await runPreToolHooks(tu.name, tu.input, hookCtx);
    if (preResult.blocked) {
        return {
            type: 'tool_result', tool_use_id: tu.id,
            content: `[Blocked by hook]: ${preResult.reason}`, is_error: true
        };
    }
    const finalInput = preResult.finalInput;

    callbacks?.onToolStart?.(tu.name, finalInput, tu.id);

    let rsMsg = '';
    let isError = false;
    let resultPayload: any;

    try {
        resultPayload = await executeTool(tu.name, finalInput as ToolInput, toolCtx, permissionMode);
        rsMsg = typeof resultPayload.output === 'string' ? resultPayload.output : JSON.stringify(resultPayload.output);
        if (resultPayload.error) {
            isError = true;
            rsMsg = `[Error]: ${resultPayload.error}\n${rsMsg}`;
        }
    } catch (err: any) {
        isError = true;
        rsMsg = `[Internal Tool Error]: ${err.message}`;
        resultPayload = { success: false, output: rsMsg, error: err.message, duration_ms: 0 };
    }

    // Post-tool hooks: can inject system notes
    await runPostToolHooks(tu.name, finalInput, resultPayload ?? { success: false, output: rsMsg }, hookCtx);

    callbacks?.onToolResult?.(tu.name, { ...resultPayload, callId: tu.id });

    if (rsMsg.length > MAX_TOOL_OUTPUT_LENGTH) {
        rsMsg = rsMsg.slice(0, MAX_TOOL_OUTPUT_LENGTH) + '\n...[truncated]';
    }

    // If the tool emitted multimodal content (e.g. an image), forward it
    // verbatim and append the stringified output as a trailing text block so
    // the model still sees numeric metadata.
    if (!isError && resultPayload?.contentBlocks && Array.isArray(resultPayload.contentBlocks) && resultPayload.contentBlocks.length > 0) {
        const mm: import('../../../types/agent').ToolResultContentItem[] = [...resultPayload.contentBlocks];
        if (rsMsg.trim().length > 0) mm.push({ type: 'text', text: rsMsg });
        return { type: 'tool_result', tool_use_id: tu.id, content: mm, is_error: false };
    }

    return {
        type: 'tool_result',
        tool_use_id: tu.id,
        content: rsMsg,
        is_error: isError
    };
}
