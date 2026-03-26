/**
 * Google Gemini Provider — uses the Gemini REST API directly.
 */

import type { ProviderAdapter, ProviderConfig, ProviderMessage, ProviderTool, ProviderToolCall, ProviderResponse } from './base';
import { throttle, on429, onSuccess } from './throttle';

export class GoogleAdapter implements ProviderAdapter {
    readonly id = 'gemini';
    readonly label = 'Gemini 2.5 Pro';
    readonly color = 'amber';
    readonly model = 'gemini-2.5-pro-preview-06-05';

    async chat(
        config: ProviderConfig,
        messages: ProviderMessage[],
        tools: ProviderTool[],
        _toolChoice?: 'auto' | 'required' | 'none',
    ): Promise<ProviderResponse> {
        const model = config.model || this.model;
        const systemInstruction = messages.find(m => m.role === 'system')?.content ?? '';

        // Convert messages to Gemini format
        const contents = messages.filter(m => m.role !== 'system').map(m => {
            if (m.role === 'tool') {
                return {
                    role: 'function',
                    parts: [{ functionResponse: { name: 'tool_result', response: { result: m.content } } }],
                };
            }
            if (m.role === 'assistant' && m.toolCalls?.length) {
                const parts: unknown[] = [];
                if (m.content) parts.push({ text: m.content });
                for (const tc of m.toolCalls) {
                    let args = {};
                    try { args = JSON.parse(tc.arguments); } catch { /* */ }
                    parts.push({ functionCall: { name: tc.name, args } });
                }
                return { role: 'model', parts };
            }
            return {
                role: m.role === 'user' ? 'user' : 'model',
                parts: [{ text: m.content ?? '' }],
            };
        });

        // Convert tools to Gemini format
        const geminiTools = tools.length > 0 ? [{
            functionDeclarations: tools.map(t => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            })),
        }] : undefined;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`;
        const payload = JSON.stringify({
            systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
            contents,
            tools: geminiTools,
            generationConfig: { maxOutputTokens: config.maxTokens ?? 4096 },
        });

        const MAX_RETRIES = 7;
        let res!: Response;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            await throttle('gemini');
            res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });

            if (res.ok) { onSuccess('gemini'); break; }

            const isRetryable = res.status === 429 || res.status >= 500;
            if (!isRetryable || attempt === MAX_RETRIES) {
                const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
                throw new Error(`Gemini API error (${res.status}): ${err?.error?.message || res.statusText}`);
            }

            const waitMs = on429('gemini');
            console.warn(`[Gemini] ${res.status} — retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(waitMs / 1000)}s`);
            await new Promise(r => setTimeout(r, waitMs));
        }

        const data = await res.json() as {
            candidates: Array<{
                content: { parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }> };
                finishReason: string;
            }>;
            usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
        };

        const candidate = data.candidates?.[0];
        if (!candidate) throw new Error('Gemini: empty response');

        const textParts = candidate.content.parts.filter(p => p.text);
        const fnParts = candidate.content.parts.filter(p => p.functionCall);

        const toolCalls: ProviderToolCall[] = fnParts.map((p, i) => ({
            id: `gemini-${Date.now()}-${i}`,
            name: p.functionCall!.name,
            arguments: JSON.stringify(p.functionCall!.args),
        }));

        let finishReason: ProviderResponse['finishReason'] = 'stop';
        if (fnParts.length > 0) finishReason = 'tool_calls';
        else if (candidate.finishReason === 'MAX_TOKENS') finishReason = 'length';

        return {
            content: textParts.map(p => p.text).join('\n') || null,
            toolCalls,
            reasoning: null,
            finishReason,
            usage: {
                inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
                outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
            },
        };
    }
}
