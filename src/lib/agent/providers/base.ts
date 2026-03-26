/**
 * Provider Adapter — Base interface for all AI providers.
 * OpenCode-style: each provider implements a common interface.
 */

export interface ProviderMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    toolCalls?: ProviderToolCall[];
    toolCallId?: string;
    reasoning?: string;
}

export interface ProviderToolCall {
    id: string;
    name: string;
    arguments: string;
}

export interface ProviderTool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface ProviderResponse {
    content: string | null;
    toolCalls: ProviderToolCall[];
    reasoning: string | null;
    finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
    usage: { inputTokens: number; outputTokens: number };
}

export interface ProviderConfig {
    apiKey: string;
    model: string;
    maxTokens?: number;
    temperature?: number;
}

export interface ProviderAdapter {
    readonly id: string;
    readonly label: string;
    readonly color: string;
    readonly model: string;

    chat(
        config: ProviderConfig,
        messages: ProviderMessage[],
        tools: ProviderTool[],
        toolChoice?: 'auto' | 'required' | 'none',
    ): Promise<ProviderResponse>;
}

export interface ProviderInfo {
    id: string;
    label: string;
    model: string;
    color: string;
    envKey: string;
}
