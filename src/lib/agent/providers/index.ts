/**
 * Provider Registry — resolves provider by ID, handles fallback.
 */

import type { ProviderAdapter, ProviderInfo } from './base';
import { AnthropicAdapter } from './anthropic';
import { OpenAIAdapter } from './openai';
import { MoonshotAdapter } from './moonshot';
import { DeepSeekAdapter } from './deepseek';
import { GoogleAdapter } from './google';

export type AgentProvider = 'claude' | 'gpt' | 'kimi' | 'deepseek' | 'gemini';

const adapters: Record<AgentProvider, ProviderAdapter> = {
    claude: new AnthropicAdapter(),
    gpt: new OpenAIAdapter(),
    kimi: new MoonshotAdapter(),
    deepseek: new DeepSeekAdapter(),
    gemini: new GoogleAdapter(),
};

export const PROVIDER_INFO: Record<AgentProvider, ProviderInfo> = {
    claude: { id: 'claude', label: 'Claude Sonnet 4', model: 'claude-sonnet-4-20250514', color: 'violet', envKey: 'ANTHROPIC_API_KEY' },
    gpt: { id: 'gpt', label: 'GPT-5.4', model: 'gpt-5.4', color: 'green', envKey: 'OPENAI_API_KEY' },
    kimi: { id: 'kimi', label: 'Kimi K2.5', model: 'kimi-k2.5', color: 'blue', envKey: 'MOONSHOT_API_KEY' },
    deepseek: { id: 'deepseek', label: 'DeepSeek R1', model: 'deepseek-reasoner', color: 'cyan', envKey: 'DEEPSEEK_API_KEY' },
    gemini: { id: 'gemini', label: 'Gemini 2.5 Pro', model: 'gemini-2.5-pro-preview-06-05', color: 'amber', envKey: 'GOOGLE_AI_API_KEY' },
};

const ALL_PROVIDERS: AgentProvider[] = ['claude', 'kimi', 'gpt', 'deepseek', 'gemini'];

export function getAdapter(id: AgentProvider): ProviderAdapter {
    return adapters[id];
}

export function resolveProvider(requested: string): { adapter: ProviderAdapter; apiKey: string; provider: AgentProvider } | null {
    const validProviders = ALL_PROVIDERS.filter(p => p === requested || !requested);
    const order = requested && ALL_PROVIDERS.includes(requested as AgentProvider)
        ? [requested as AgentProvider, ...ALL_PROVIDERS.filter(p => p !== requested)]
        : ALL_PROVIDERS;

    for (const id of order) {
        const key = process.env[PROVIDER_INFO[id].envKey];
        if (key) {
            return { adapter: adapters[id], apiKey: key, provider: id };
        }
    }
    return null;
}

export { type ProviderAdapter, type ProviderConfig, type ProviderMessage, type ProviderTool, type ProviderToolCall, type ProviderResponse } from './base';
