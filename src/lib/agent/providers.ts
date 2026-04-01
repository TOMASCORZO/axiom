/**
 * Provider abstraction — direct SDK/fetch for Claude, OpenAI, and Moonshot.
 * Refactored to match Claude Code's streaming QueryEngine architecture.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
    Message,
    StreamEvent
} from '../../types/agent';

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

/**
 * A provider uses an AsyncGenerator to yield StreamEvents in real-time.
 */
export interface ChatProvider {
    id: ProviderId;
    chat(params: {
        system: string;
        messages: Message[];
        tools: ToolSchema[];
        maxTokens: number;
        temperature: number;
        forceToolUse: boolean;
    }): AsyncGenerator<StreamEvent, void, unknown>;

    buildMessages(messages: Message[]): unknown[];
}

// ── Claude Provider (Anthropic SDK) ──────────────────────────────────

class ClaudeProvider implements ChatProvider {
    id: ProviderId = 'claude';
    private client: Anthropic;
    private modelId: string;

    constructor(apiKey: string, modelId: string) {
        this.client = new Anthropic({ apiKey });
        this.modelId = modelId;
    }

    buildMessages(messages: Message[]): Anthropic.MessageParam[] {
        const msgs: Anthropic.MessageParam[] = [];
        
        for (const msg of messages) {
            if (msg.type === 'system') continue; // system handled separately
            
            if (msg.type === 'user') {
                if (typeof msg.message.content === 'string') {
                    msgs.push({ role: 'user', content: msg.message.content });
                } else {
                    const content: Array<Anthropic.TextBlockParam | Anthropic.ToolResultBlockParam> = [];
                    for (const block of msg.message.content) {
                        if (block.type === 'text') {
                            content.push({ type: 'text', text: block.text });
                        } else if (block.type === 'tool_result') {
                            content.push({ 
                                type: 'tool_result', 
                                tool_use_id: block.tool_use_id, 
                                content: block.content,
                                is_error: block.is_error
                            });
                        }
                    }
                    msgs.push({ role: 'user', content });
                }
            } else if (msg.type === 'assistant') {
                const content: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];
                for (const block of msg.message.content) {
                    if (block.type === 'text') {
                        content.push({ type: 'text', text: block.text });
                    } else if (block.type === 'tool_use') {
                        content.push({
                            type: 'tool_use',
                            id: block.id,
                            name: block.name,
                            input: block.input as Record<string, unknown>
                        });
                    }
                }
                msgs.push({ role: 'assistant', content });
            }
        }
        return msgs;
    }

    async *chat(params: {
        system: string;
        messages: Message[];
        tools: ToolSchema[];
        maxTokens: number;
        temperature: number;
        forceToolUse: boolean;
    }): AsyncGenerator<StreamEvent, void, unknown> {
        const anthropicMessages = this.buildMessages(params.messages);
        
        const anthropicTools: Anthropic.Tool[] = params.tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters as Anthropic.Tool.InputSchema,
        }));

        try {
            const stream = await this.client.messages.create({
                model: this.modelId,
                max_tokens: params.maxTokens,
                temperature: params.temperature,
                system: params.system,
                messages: anthropicMessages,
                tools: anthropicTools.length > 0 ? anthropicTools : undefined,
                stream: true,
                tool_choice: params.forceToolUse && anthropicTools.length > 0
                    ? { type: 'any' }
                    : undefined,
            });

            for await (const chunk of stream) {
                if (chunk.type === 'message_start') {
                    yield { type: 'message_start', message: { usage: { inputTokens: chunk.message.usage.input_tokens, outputTokens: chunk.message.usage.output_tokens } } };
                } else if (chunk.type === 'content_block_start') {
                    if (chunk.content_block.type === 'text') {
                        yield { type: 'content_block_start', index: chunk.index, block: { type: 'text' } };
                    } else if (chunk.content_block.type === 'tool_use') {
                        yield { type: 'content_block_start', index: chunk.index, block: { type: 'tool_use', id: chunk.content_block.id, name: chunk.content_block.name } };
                    }
                } else if (chunk.type === 'content_block_delta') {
                    if (chunk.delta.type === 'text_delta') {
                        yield { type: 'content_block_delta', index: chunk.index, delta: { type: 'text_delta', text: chunk.delta.text } };
                    } else if (chunk.delta.type === 'input_json_delta') {
                        yield { type: 'content_block_delta', index: chunk.index, delta: { type: 'input_json_delta', partial_json: chunk.delta.partial_json } };
                    }
                } else if (chunk.type === 'content_block_stop') {
                    yield { type: 'content_block_stop', index: chunk.index };
                } else if (chunk.type === 'message_delta') {
                    yield { type: 'message_delta', usage: { outputTokens: chunk.usage.output_tokens }, stop_reason: chunk.delta.stop_reason || undefined };
                } else if (chunk.type === 'message_stop') {
                    yield { type: 'message_stop' };
                }
            }
        } catch (err: any) {
            yield { type: 'error', error: { type: 'api_error', message: err.message || String(err) } };
        }
    }
}

// ── OpenAI-Compatible Provider (raw fetch) ───────────────────────────

interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | null;
    reasoning_content?: string | null;
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

    buildMessages(messages: Message[]): OpenAIMessage[] {
        const msgs: OpenAIMessage[] = [];
        for (const msg of messages) {
            if (msg.type === 'system') continue;
            
            if (msg.type === 'user') {
                if (typeof msg.message.content === 'string') {
                    msgs.push({ role: 'user', content: msg.message.content });
                } else {
                    // Separate tool results into distinct messages for OpenAI
                    for (const block of msg.message.content) {
                        if (block.type === 'text') {
                            msgs.push({ role: 'user', content: block.text });
                        } else if (block.type === 'tool_result') {
                            msgs.push({
                                role: 'tool',
                                tool_call_id: block.tool_use_id,
                                content: block.content
                            });
                        }
                    }
                }
            } else if (msg.type === 'assistant') {
                const assistantMsg: OpenAIMessage = { role: 'assistant', content: '' };
                const tc: NonNullable<OpenAIMessage['tool_calls']> = [];
                for (const block of msg.message.content) {
                    if (block.type === 'text') {
                        assistantMsg.content += block.text;
                    } else if (block.type === 'tool_use') {
                        tc.push({
                            id: block.id,
                            type: 'function',
                            function: { name: block.name, arguments: JSON.stringify(block.input) }
                        });
                    }
                }
                if (tc.length > 0) assistantMsg.tool_calls = tc;
                if (!assistantMsg.content) assistantMsg.content = null;
                msgs.push(assistantMsg);
            }
        }
        return msgs;
    }

    async *chat(params: {
        system: string;
        messages: Message[];
        tools: ToolSchema[];
        maxTokens: number;
        temperature: number;
        forceToolUse: boolean;
    }): AsyncGenerator<StreamEvent, void, unknown> {
        const openaiTools = params.tools.map(t => ({
            type: 'function' as const,
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            },
        }));

        const fullMessages: OpenAIMessage[] = [
            { role: 'system', content: params.system },
            ...this.buildMessages(params.messages),
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
            if (params.forceToolUse) body.tool_choice = 'required';
        }

        try {
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
                yield { type: 'error', error: { type: 'api_error', message: `${this.id} API error (${response.status}): ${errBody}` } };
                return;
            }

            yield* this.parseSSEStream(response);
        } catch (err: any) {
            yield { type: 'error', error: { type: 'api_error', message: err.message || String(err) } };
        }
    }

    private async *parseSSEStream(response: Response): AsyncGenerator<StreamEvent, void, unknown> {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();

        yield { type: 'message_start', message: { usage: { inputTokens: 0, outputTokens: 0 } } };

        let blockIndex = 0;
        let inToolCall = false;
        let currentToolId = '';
        let currentToolName = '';

        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? ''; 

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;

                let chunk;
                try { chunk = JSON.parse(data); } catch { continue; }

                if (chunk.usage) {
                    yield { type: 'message_delta', usage: { outputTokens: chunk.usage.completion_tokens || 0 } };
                }

                const choice = chunk.choices?.[0];
                if (!choice) continue;

                const delta = choice.delta;
                if (!delta) continue;

                // Stop Reason
                if (choice.finish_reason) {
                    yield { type: 'message_delta', usage: { outputTokens: 0 }, stop_reason: choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn' };
                }

                // Text
                if (delta.content) {
                    if (blockIndex === 0 && !inToolCall) {
                        yield { type: 'content_block_start', index: blockIndex, block: { type: 'text' } };
                    }
                    yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: delta.content } };
                }

                // Reasoning
                if (delta.reasoning_content) {
                    if (blockIndex === 0 && !inToolCall) {
                        yield { type: 'content_block_start', index: blockIndex, block: { type: 'text' } };
                    }
                    yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'reasoning_delta', text: delta.reasoning_content } };
                }

                // Tools
                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        if (tc.id) {
                            if (inToolCall) {
                                yield { type: 'content_block_stop', index: blockIndex };
                                blockIndex++;
                            } else if (blockIndex === 0 && !delta.content && !delta.reasoning_content) {
                                // If the first block is a tool call, we close the implicitly opened text block if there was none.
                                // Actually, openai sends tool_calls without explicit start blocks.
                            }
                            currentToolId = tc.id;
                            currentToolName = tc.function?.name || '';
                            yield { type: 'content_block_start', index: ++blockIndex, block: { type: 'tool_use', id: currentToolId, name: currentToolName } };
                            inToolCall = true;
                        }
                        if (tc.function?.arguments) {
                            yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } };
                        }
                    }
                }
            }
        }
        
        if (inToolCall) {
            yield { type: 'content_block_stop', index: blockIndex };
        } else {
            yield { type: 'content_block_stop', index: blockIndex }; // close text block
        }
        yield { type: 'message_stop' };
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
        const cfg = {
            claude: { id: 'claude', label: 'Claude Sonnet 4', modelId: 'claude-sonnet-4-20250514', envKey: 'ANTHROPIC_API_KEY' },
            gpt: { id: 'gpt', label: 'GPT-4.1', modelId: 'gpt-4.1', envKey: 'OPENAI_API_KEY' },
            kimi: { id: 'kimi', label: 'Kimi K2', modelId: 'kimi-k2', envKey: 'MOONSHOT_API_KEY' }
        }[id] as ProviderConfig;
        
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
