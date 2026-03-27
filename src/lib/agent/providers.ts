/**
 * Provider abstraction — direct SDK/fetch for Claude, OpenAI, and Moonshot.
 *
 * No Vercel AI SDK. No middleware layers that hide errors.
 * - Claude: @anthropic-ai/sdk (streaming)
 * - OpenAI/Moonshot: raw fetch to /v1/chat/completions (streaming)
 */

import Anthropic from '@anthropic-ai/sdk';

// ── Types ────────────────────────────────────────────────────────────

export type ProviderId = 'claude' | 'gpt' | 'kimi';

export interface ProviderConfig {
    id: ProviderId;
    label: string;
    modelId: string;
    envKey: string;
}

export interface ToolSchema {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
    id: string;
    name: string;
    input: Record<string, unknown>;
}

export interface StepResult {
    text: string;
    toolCalls: ToolCall[];
    done: boolean;
    usage: { inputTokens: number; outputTokens: number };
}

export interface ChatCallbacks {
    onText?: (text: string) => void;
    onReasoning?: (text: string) => void;
}

/**
 * A provider can make one chat completion call (possibly multi-step internally
 * for streaming). Returns text + tool calls for the loop to handle.
 */
export interface ChatProvider {
    id: ProviderId;
    chat(params: {
        system: string;
        messages: unknown[]; // provider-specific message format
        tools: ToolSchema[];
        maxTokens: number;
        temperature: number;
        forceToolUse: boolean;
        callbacks: ChatCallbacks;
    }): Promise<StepResult>;

    /** Build initial messages from user message + history */
    buildMessages(
        history: Array<{ role: 'user' | 'assistant'; content: string }>,
        userMessage: string,
    ): unknown[];

    /** Append assistant response + tool results to the message array */
    appendToolResults(
        messages: unknown[],
        stepResult: StepResult,
        toolResults: Array<{ callId: string; output: string }>,
    ): unknown[];
}

// ── Retry Helper ────────────────────────────────────────────────────

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;

async function withRetry<T>(
    label: string,
    fn: () => Promise<T>,
    isRetryable: (err: unknown) => boolean = () => false,
): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!isRetryable(err) || attempt === MAX_RETRIES - 1) throw err;
            const delay = BASE_DELAY_MS * Math.pow(2, attempt); // 2s, 4s, 8s, 16s, 32s
            console.warn(`[${label}] Retryable error (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delay}ms:`, err instanceof Error ? err.message : err);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

// ── Provider Info ────────────────────────────────────────────────────

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
    claude: { id: 'claude', label: 'Claude Sonnet 4', modelId: 'claude-sonnet-4-20250514', envKey: 'ANTHROPIC_API_KEY' },
    gpt: { id: 'gpt', label: 'GPT-4o', modelId: 'gpt-4o', envKey: 'OPENAI_API_KEY' },
    kimi: { id: 'kimi', label: 'Moonshot 128K', modelId: 'moonshot-v1-128k', envKey: 'MOONSHOT_API_KEY' },
};

// ── Claude Provider (Anthropic SDK) ──────────────────────────────────

class ClaudeProvider implements ChatProvider {
    id: ProviderId = 'claude';
    private client: Anthropic;
    private modelId: string;

    constructor(apiKey: string, modelId: string) {
        this.client = new Anthropic({ apiKey });
        this.modelId = modelId;
    }

    buildMessages(
        history: Array<{ role: 'user' | 'assistant'; content: string }>,
        userMessage: string,
    ): Anthropic.MessageParam[] {
        const msgs: Anthropic.MessageParam[] = [];
        for (const h of history) {
            msgs.push({ role: h.role, content: h.content });
        }
        msgs.push({ role: 'user', content: userMessage });
        return msgs;
    }

    appendToolResults(
        messages: Anthropic.MessageParam[],
        stepResult: StepResult,
        toolResults: Array<{ callId: string; output: string }>,
    ): Anthropic.MessageParam[] {
        // Append the assistant's response (text + tool_use blocks)
        const contentBlocks: Anthropic.ContentBlock[] = [];
        if (stepResult.text) {
            contentBlocks.push({ type: 'text', text: stepResult.text } as Anthropic.TextBlock);
        }
        for (const tc of stepResult.toolCalls) {
            contentBlocks.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.name,
                input: tc.input,
            } as Anthropic.ToolUseBlock);
        }
        messages.push({ role: 'assistant', content: contentBlocks });

        // Append tool results as a user message
        const resultBlocks: Anthropic.ToolResultBlockParam[] = toolResults.map(tr => ({
            type: 'tool_result' as const,
            tool_use_id: tr.callId,
            content: tr.output,
        }));
        messages.push({ role: 'user', content: resultBlocks });

        return messages;
    }

    async chat(params: {
        system: string;
        messages: Anthropic.MessageParam[];
        tools: ToolSchema[];
        maxTokens: number;
        temperature: number;
        forceToolUse: boolean;
        callbacks: ChatCallbacks;
    }): Promise<StepResult> {
        const anthropicTools: Anthropic.Tool[] = params.tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters as Anthropic.Tool.InputSchema,
        }));

        return withRetry('claude', async () => {
            const stream = this.client.messages.stream({
                model: this.modelId,
                max_tokens: params.maxTokens,
                temperature: params.temperature,
                system: params.system,
                messages: params.messages,
                tools: anthropicTools.length > 0 ? anthropicTools : undefined,
                tool_choice: params.forceToolUse && anthropicTools.length > 0
                    ? { type: 'any' }
                    : undefined,
            });

            let text = '';
            stream.on('text', (delta) => {
                text += delta;
                params.callbacks.onText?.(delta);
            });

            const finalMessage = await stream.finalMessage();

            const toolCalls: ToolCall[] = [];
            for (const block of finalMessage.content) {
                if (block.type === 'tool_use') {
                    toolCalls.push({
                        id: block.id,
                        name: block.name,
                        input: block.input as Record<string, unknown>,
                    });
                }
            }

            return {
                text,
                toolCalls,
                done: finalMessage.stop_reason === 'end_turn' || finalMessage.stop_reason === 'max_tokens',
                usage: {
                    inputTokens: finalMessage.usage?.input_tokens ?? 0,
                    outputTokens: finalMessage.usage?.output_tokens ?? 0,
                },
            };
        }, (err) => {
            // Retry on 429 (rate limit) and 5xx (server errors)
            const msg = err instanceof Error ? err.message : String(err);
            return msg.includes('429') || msg.includes('overloaded') || msg.includes('529') || msg.includes('500');
        });
    }
}

// ── OpenAI-Compatible Provider (raw fetch) ───────────────────────────

interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | null;
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
}

class OpenAICompatProvider implements ChatProvider {
    id: ProviderId;
    private apiKey: string;
    private baseUrl: string;
    private modelId: string;

    constructor(id: ProviderId, apiKey: string, baseUrl: string, modelId: string) {
        this.id = id;
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
        this.modelId = modelId;
    }

    buildMessages(
        history: Array<{ role: 'user' | 'assistant'; content: string }>,
        userMessage: string,
    ): OpenAIMessage[] {
        const msgs: OpenAIMessage[] = [];
        for (const h of history) {
            msgs.push({ role: h.role, content: h.content });
        }
        msgs.push({ role: 'user', content: userMessage });
        return msgs;
    }

    appendToolResults(
        messages: OpenAIMessage[],
        stepResult: StepResult,
        toolResults: Array<{ callId: string; output: string }>,
    ): OpenAIMessage[] {
        // Append assistant message with tool_calls
        const assistantMsg: OpenAIMessage = {
            role: 'assistant',
            content: stepResult.text || null,
        };
        if (stepResult.toolCalls.length > 0) {
            assistantMsg.tool_calls = stepResult.toolCalls.map(tc => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            }));
        }
        messages.push(assistantMsg);

        // Append each tool result as a separate tool message
        for (const tr of toolResults) {
            messages.push({
                role: 'tool',
                tool_call_id: tr.callId,
                content: tr.output,
            });
        }

        return messages;
    }

    async chat(params: {
        system: string;
        messages: OpenAIMessage[];
        tools: ToolSchema[];
        maxTokens: number;
        temperature: number;
        forceToolUse: boolean;
        callbacks: ChatCallbacks;
    }): Promise<StepResult> {
        const openaiTools = params.tools.map(t => ({
            type: 'function' as const,
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            },
        }));

        // Build full messages with system message prepended
        const fullMessages: OpenAIMessage[] = [
            { role: 'system', content: params.system },
            ...params.messages,
        ];

        const body: Record<string, unknown> = {
            model: this.modelId,
            messages: fullMessages,
            max_tokens: params.maxTokens,
            temperature: params.temperature,
            stream: true,
            stream_options: { include_usage: true },
        };

        if (openaiTools.length > 0) {
            body.tools = openaiTools;
            if (params.forceToolUse) {
                body.tool_choice = 'required';
            }
        }

        return withRetry(this.id, async () => {
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const errBody = await response.text();
                throw new Error(`${this.id} API error (${response.status}): ${errBody}`);
            }

            return this.parseSSEStream(response, params.callbacks);
        }, (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            return msg.includes('429') || msg.includes('overloaded') || msg.includes('500');
        });
    }

    private async parseSSEStream(
        response: Response,
        callbacks: ChatCallbacks,
    ): Promise<StepResult> {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();

        let text = '';
        const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
        let inputTokens = 0;
        let outputTokens = 0;
        let finishReason = '';
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;

                let chunk;
                try { chunk = JSON.parse(data); } catch { continue; }

                // Usage
                if (chunk.usage) {
                    inputTokens = chunk.usage.prompt_tokens ?? 0;
                    outputTokens = chunk.usage.completion_tokens ?? 0;
                }

                const choice = chunk.choices?.[0];
                if (!choice) continue;

                if (choice.finish_reason) {
                    finishReason = choice.finish_reason;
                }

                const delta = choice.delta;
                if (!delta) continue;

                // Text content
                if (delta.content) {
                    text += delta.content;
                    callbacks.onText?.(delta.content);
                }

                // Tool calls (arrive incrementally)
                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? 0;
                        if (!toolCallMap.has(idx)) {
                            toolCallMap.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
                        }
                        const entry = toolCallMap.get(idx)!;
                        if (tc.id) entry.id = tc.id;
                        if (tc.function?.name) entry.name = tc.function.name;
                        if (tc.function?.arguments) entry.args += tc.function.arguments;
                    }
                }
            }
        }

        // Parse accumulated tool calls
        const toolCalls: ToolCall[] = [];
        for (const [, tc] of toolCallMap) {
            let input: Record<string, unknown> = {};
            try { input = JSON.parse(tc.args); } catch { /* malformed args */ }
            toolCalls.push({ id: tc.id, name: tc.name, input });
        }

        return {
            text,
            toolCalls,
            done: finishReason === 'stop' || finishReason === 'length',
            usage: { inputTokens, outputTokens },
        };
    }
}

// ── Factory ──────────────────────────────────────────────────────────

const FALLBACK_ORDER: ProviderId[] = ['claude', 'kimi', 'gpt'];

export function resolveProvider(requested?: ProviderId): {
    provider: ChatProvider;
    config: ProviderConfig;
} | null {
    const order = requested
        ? [requested, ...FALLBACK_ORDER.filter(p => p !== requested)]
        : FALLBACK_ORDER;

    for (const id of order) {
        const cfg = PROVIDERS[id];
        const key = process.env[cfg.envKey];
        if (!key) continue;

        switch (id) {
            case 'claude':
                return { provider: new ClaudeProvider(key, cfg.modelId), config: cfg };
            case 'gpt':
                return { provider: new OpenAICompatProvider('gpt', key, 'https://api.openai.com/v1', cfg.modelId), config: cfg };
            case 'kimi':
                return { provider: new OpenAICompatProvider('kimi', key, 'https://api.moonshot.ai/v1', cfg.modelId), config: cfg };
        }
    }
    return null;
}
