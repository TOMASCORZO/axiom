/**
 * AI SDK Provider Factory — OpenCode pattern.
 *
 * Uses Vercel AI SDK to create provider instances for all supported models.
 * This replaces the manual HTTP adapters with battle-tested SDK implementations
 * that handle tool calls, streaming, and message formatting correctly.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';

export type AgentProvider = 'claude' | 'gpt' | 'kimi' | 'deepseek' | 'gemini';

export interface ProviderInfo {
    id: AgentProvider;
    label: string;
    modelId: string;
    color: string;
    envKey: string;
}

export const PROVIDER_INFO: Record<AgentProvider, ProviderInfo> = {
    claude: { id: 'claude', label: 'Claude Sonnet 4', modelId: 'claude-sonnet-4-20250514', color: 'violet', envKey: 'ANTHROPIC_API_KEY' },
    gpt: { id: 'gpt', label: 'GPT-5.4', modelId: 'gpt-5.4', color: 'green', envKey: 'OPENAI_API_KEY' },
    kimi: { id: 'kimi', label: 'Kimi K2.5', modelId: 'kimi-k2.5', color: 'blue', envKey: 'MOONSHOT_API_KEY' },
    deepseek: { id: 'deepseek', label: 'DeepSeek R1', modelId: 'deepseek-reasoner', color: 'cyan', envKey: 'DEEPSEEK_API_KEY' },
    gemini: { id: 'gemini', label: 'Gemini 2.5 Pro', modelId: 'gemini-2.5-pro-preview-06-05', color: 'amber', envKey: 'GOOGLE_AI_API_KEY' },
};

const ALL_PROVIDERS: AgentProvider[] = ['claude', 'kimi', 'gpt', 'deepseek', 'gemini'];

/**
 * Create an AI SDK LanguageModel for the given provider.
 * OpenCode pattern: each provider gets its own SDK instance with proper baseURL/apiKey.
 */
export function createModel(provider: AgentProvider, apiKey: string): LanguageModel {
    const info = PROVIDER_INFO[provider];

    switch (provider) {
        case 'claude': {
            const anthropic = createAnthropic({ apiKey });
            return anthropic(info.modelId);
        }
        case 'gpt': {
            const openai = createOpenAI({ apiKey });
            return openai(info.modelId);
        }
        case 'kimi': {
            const kimi = createOpenAI({
                apiKey,
                baseURL: 'https://api.moonshot.ai/v1',
            });
            return kimi(info.modelId);
        }
        case 'deepseek': {
            const deepseek = createOpenAI({
                apiKey,
                baseURL: 'https://api.deepseek.com/v1',
            });
            return deepseek(info.modelId);
        }
        case 'gemini': {
            const google = createGoogleGenerativeAI({ apiKey });
            return google(info.modelId);
        }
    }
}

/**
 * Resolve provider — tries requested first, then falls back through all configured providers.
 * Returns null if no provider has an API key configured.
 */
export function resolveProvider(requested: AgentProvider): {
    model: LanguageModel;
    apiKey: string;
    provider: AgentProvider;
} | null {
    const order = [requested, ...ALL_PROVIDERS.filter(p => p !== requested)];

    for (const id of order) {
        const key = process.env[PROVIDER_INFO[id].envKey];
        if (key) {
            return {
                model: createModel(id, key),
                apiKey: key,
                provider: id,
            };
        }
    }
    return null;
}
