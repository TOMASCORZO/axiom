/**
 * Anthropic (Claude) Provider Adapter
 */

import type { ProviderAdapter, ProviderConfig, ProviderMessage, ProviderTool, ProviderToolCall, ProviderResponse } from './base';

export class AnthropicAdapter implements ProviderAdapter {
    readonly id = 'claude';
    readonly label = 'Claude Sonnet 4';
    readonly color = 'violet';
    readonly model = 'claude-sonnet-4-20250514';

    async chat(
        config: ProviderConfig,
        messages: ProviderMessage[],
        tools: ProviderTool[],
        _toolChoice?: 'auto' | 'required' | 'none',
    ): Promise<ProviderResponse> {
        const system = messages.find(m => m.role === 'system')?.content ?? '';

        // Convert messages to Anthropic format
        const formatted = messages.filter(m => m.role !== 'system').map(m => {
            if (m.role === 'assistant' && m.toolCalls?.length) {
                const blocks: unknown[] = [];
                if (m.content) blocks.push({ type: 'text', text: m.content });
                for (const tc of m.toolCalls) {
                    let input = {};
                    try { input = JSON.parse(tc.arguments); } catch { /* */ }
                    blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
                }
                return { role: 'assistant', content: blocks };
            }
            if (m.role === 'tool') {
                return {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content ?? '' }],
                };
            }
            return { role: m.role === 'user' ? 'user' : 'assistant', content: m.content ?? '' };
        });

        const anthropicTools = tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
        }));

        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': config.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: config.model || this.model,
                max_tokens: config.maxTokens ?? 4096,
                system,
                messages: formatted,
                tools: anthropicTools.length > 0 ? anthropicTools : undefined,
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
            throw new Error(`Claude API error: ${err?.error?.message || res.statusText}`);
        }

        const data = await res.json() as {
            content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
            stop_reason: string;
            usage: { input_tokens: number; output_tokens: number };
        };

        const textBlocks = data.content.filter(b => b.type === 'text');
        const toolBlocks = data.content.filter(b => b.type === 'tool_use');

        const toolCalls: ProviderToolCall[] = toolBlocks.map(b => ({
            id: b.id!,
            name: b.name!,
            arguments: JSON.stringify(b.input),
        }));

        let finishReason: ProviderResponse['finishReason'] = 'stop';
        if (data.stop_reason === 'tool_use') finishReason = 'tool_calls';
        else if (data.stop_reason === 'max_tokens') finishReason = 'length';

        return {
            content: textBlocks.map(b => b.text).join('\n') || null,
            toolCalls,
            reasoning: null,
            finishReason,
            usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
        };
    }
}
