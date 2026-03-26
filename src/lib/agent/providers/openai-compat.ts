/**
 * OpenAI-Compatible Provider Base — shared by GPT, Kimi, DeepSeek
 */

import type { ProviderAdapter, ProviderConfig, ProviderMessage, ProviderTool, ProviderToolCall, ProviderResponse } from './base';

export abstract class OpenAICompatAdapter implements ProviderAdapter {
    abstract readonly id: string;
    abstract readonly label: string;
    abstract readonly color: string;
    abstract readonly model: string;
    abstract readonly baseUrl: string;

    /** Override to customize request body */
    protected customizeBody(body: Record<string, unknown>, _tools: ProviderTool[]): Record<string, unknown> {
        return body;
    }

    async chat(
        config: ProviderConfig,
        messages: ProviderMessage[],
        tools: ProviderTool[],
        toolChoice: 'auto' | 'required' | 'none' = 'auto',
    ): Promise<ProviderResponse> {
        const formatted = messages.map(m => {
            const msg: Record<string, unknown> = { role: m.role, content: m.content ?? '' };
            if (m.toolCalls?.length) {
                msg.tool_calls = m.toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: tc.arguments },
                }));
            }
            if (m.toolCallId) msg.tool_call_id = m.toolCallId;
            return msg;
        });

        const oaiTools = tools.map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
        }));

        let body: Record<string, unknown> = {
            model: config.model || this.model,
            max_tokens: config.maxTokens ?? 4096,
            messages: formatted,
        };

        if (oaiTools.length > 0) {
            body.tools = oaiTools;
            body.tool_choice = toolChoice;
        }

        body = this.customizeBody(body, tools);

        const url = `${this.baseUrl}/chat/completions`;
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
        };
        const payload = JSON.stringify(body);

        // Retry with exponential backoff on 429 / 500+ errors
        const MAX_RETRIES = 5;
        let res!: Response;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            res = await fetch(url, { method: 'POST', headers, body: payload });

            if (res.ok) break;

            const isRetryable = res.status === 429 || res.status >= 500;
            if (!isRetryable || attempt === MAX_RETRIES) {
                const errText = await res.text().catch(() => '');
                let errMsg = res.statusText;
                try {
                    const j = JSON.parse(errText) as { error?: { message?: string } };
                    errMsg = j?.error?.message || errMsg;
                } catch { /* */ }
                throw new Error(`${this.label} API error (${res.status}): ${errMsg}`);
            }

            // Read Retry-After header, fall back to exponential backoff
            const retryAfter = res.headers.get('retry-after');
            const waitMs = retryAfter
                ? parseInt(retryAfter, 10) * 1000 || 2000
                : Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30000);

            console.warn(`[${this.label}] ${res.status} — retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(waitMs)}ms`);
            await new Promise(r => setTimeout(r, waitMs));
        }

        const data = await res.json() as {
            choices: Array<{
                message: {
                    content: string | null;
                    reasoning_content?: string | null;
                    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
                };
                finish_reason: string;
            }>;
            usage: { prompt_tokens: number; completion_tokens: number };
        };

        const choice = data.choices[0];
        if (!choice) throw new Error(`${this.label}: empty response`);

        const toolCalls: ProviderToolCall[] = (choice.message.tool_calls ?? []).map(tc => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
        }));

        const hasTools = toolCalls.length > 0;
        let finishReason: ProviderResponse['finishReason'] = 'stop';
        if (choice.finish_reason === 'tool_calls' || hasTools) finishReason = 'tool_calls';
        else if (choice.finish_reason === 'length') finishReason = 'length';

        return {
            content: choice.message.content || null,
            toolCalls,
            reasoning: choice.message.reasoning_content || null,
            finishReason,
            usage: { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens },
        };
    }
}
