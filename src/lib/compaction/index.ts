/**
 * Compaction Engine — Automatic context compression for Axiom.
 *
 * OpenCode pattern: When conversation history grows too large, a background
 * process runs a cheaper/faster LLM to summarize old messages, replacing
 * them with dense synthesized summaries to free up context window budget.
 *
 * This module provides:
 * - shouldCompact(): checks if history exceeds threshold
 * - compact(): runs the compaction agent on old messages
 * - estimateTokens(): rough token count estimation
 *
 * Usage:
 *   import { CompactionEngine } from '@/lib/compaction';
 *
 *   const engine = new CompactionEngine(adapter, config);
 *   if (engine.shouldCompact(messages)) {
 *     const compacted = await engine.compact(messages);
 *   }
 */

import type { ProviderAdapter, ProviderConfig, ProviderMessage } from '../agent/providers/base';
import { bus } from '../bus';

// ── Configuration ───────────────────────────────────────────────────

/** Approximate chars per token (conservative estimate) */
const CHARS_PER_TOKEN = 4;

/** Default thresholds */
const DEFAULT_MAX_TOKENS = 80_000;         // Compact when history exceeds this
const DEFAULT_PRESERVE_RECENT = 10;        // Always keep the last N messages
const DEFAULT_SUMMARY_MAX_TOKENS = 2_000;  // Target size for the summary

// ── Types ───────────────────────────────────────────────────────────

export interface CompactionResult {
    /** The compacted messages array */
    messages: ProviderMessage[];
    /** The summary that replaced old messages */
    summary: string;
    /** Stats about the compaction */
    stats: {
        originalCount: number;
        compactedCount: number;
        originalTokens: number;
        compactedTokens: number;
        savedTokens: number;
    };
}

export interface CompactionOptions {
    maxTokens?: number;
    preserveRecent?: number;
    summaryMaxTokens?: number;
}

// ── Compaction Engine ───────────────────────────────────────────────

export class CompactionEngine {
    private maxTokens: number;
    private preserveRecent: number;
    private summaryMaxTokens: number;

    constructor(
        private adapter: ProviderAdapter,
        private config: ProviderConfig,
        options: CompactionOptions = {},
    ) {
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.preserveRecent = options.preserveRecent ?? DEFAULT_PRESERVE_RECENT;
        this.summaryMaxTokens = options.summaryMaxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS;
    }

    /**
     * Estimate the token count for a message array.
     */
    estimateTokens(messages: ProviderMessage[]): number {
        let totalChars = 0;
        for (const msg of messages) {
            totalChars += (msg.content?.length ?? 0) + (msg.reasoning?.length ?? 0);
            if (msg.toolCalls) {
                for (const tc of msg.toolCalls) {
                    totalChars += tc.arguments.length + tc.name.length;
                }
            }
        }
        return Math.ceil(totalChars / CHARS_PER_TOKEN);
    }

    /**
     * Check if the message history needs compaction.
     */
    shouldCompact(messages: ProviderMessage[]): boolean {
        const tokens = this.estimateTokens(messages);
        return tokens > this.maxTokens;
    }

    /**
     * Compact the message history by summarizing old messages.
     *
     * Strategy:
     * 1. Split messages into [system, old, recent]
     * 2. Keep the system message and recent messages intact
     * 3. Summarize the 'old' messages using a fast LLM call
     * 4. Replace old messages with a single summary message
     */
    async compact(messages: ProviderMessage[]): Promise<CompactionResult> {
        const originalCount = messages.length;
        const originalTokens = this.estimateTokens(messages);

        // Separate system message(s) from conversation
        const systemMessages = messages.filter(m => m.role === 'system');
        const conversationMessages = messages.filter(m => m.role !== 'system');

        // If not enough messages to compact, return as-is
        if (conversationMessages.length <= this.preserveRecent + 2) {
            return {
                messages,
                summary: '',
                stats: {
                    originalCount,
                    compactedCount: originalCount,
                    originalTokens,
                    compactedTokens: originalTokens,
                    savedTokens: 0,
                },
            };
        }

        // Split: keep recent messages, summarize the rest
        const oldMessages = conversationMessages.slice(0, -this.preserveRecent);
        const recentMessages = conversationMessages.slice(-this.preserveRecent);

        // Build the summarization request
        const oldContent = oldMessages.map(m => {
            const role = m.role.toUpperCase();
            const content = m.content ?? '';
            return `[${role}] ${content.slice(0, 500)}`; // Limit each message for the summary input
        }).join('\n');

        const summaryPrompt = `You are a conversation summarizer. Summarize the following conversation history into a concise but comprehensive summary. Focus on:
- What was discussed and decided
- What actions were taken (tool calls, file modifications)
- Current state of the work
- Any important context for continuing the conversation

Be concise but preserve all critical information. Do not ask questions.

CONVERSATION TO SUMMARIZE:
${oldContent}`;

        try {
            const response = await this.adapter.chat(
                this.config,
                [
                    { role: 'system', content: 'You summarize conversations concisely. Output only the summary.' },
                    { role: 'user', content: summaryPrompt },
                ],
                [], // No tools
                'auto',
            );

            const summary = response.content || 'Previous conversation context was compacted.';

            // Build the compacted message array
            const compactedMessages: ProviderMessage[] = [
                ...systemMessages,
                {
                    role: 'user',
                    content: `[COMPACTED CONTEXT — Summary of ${oldMessages.length} previous messages]\n${summary}`,
                },
                ...recentMessages,
            ];

            const compactedTokens = this.estimateTokens(compactedMessages);

            bus.emit('tool.complete', {
                toolName: 'compaction',
                success: true,
                duration_ms: 0,
                callId: `compact_${Date.now()}`,
            });

            return {
                messages: compactedMessages,
                summary,
                stats: {
                    originalCount,
                    compactedCount: compactedMessages.length,
                    originalTokens,
                    compactedTokens,
                    savedTokens: originalTokens - compactedTokens,
                },
            };
        } catch (error) {
            // If compaction fails, return original messages
            console.error('[Compaction] Failed:', error);
            return {
                messages,
                summary: '',
                stats: {
                    originalCount,
                    compactedCount: originalCount,
                    originalTokens,
                    compactedTokens: originalTokens,
                    savedTokens: 0,
                },
            };
        }
    }
}
