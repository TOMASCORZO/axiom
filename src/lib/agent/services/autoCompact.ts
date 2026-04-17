import { Message, SystemMessage } from '../../../types/agent';
import { ChatProvider } from '../providers';
import { randomUUID } from 'crypto';
import { bus } from '../../bus';

/**
 * Calculates a rough token estimation for a chunk of text.
 * Claude averages ~4 chars per token.
 */
function roughTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(messages: Message[]): number {
    let tokens = 0;
    for (const msg of messages) {
        if (msg.type === 'system') {
            tokens += roughTokenCount(msg.content);
        } else if (msg.type === 'user') {
            if (typeof msg.message.content === 'string') {
                tokens += roughTokenCount(msg.message.content);
            } else {
                for (const block of msg.message.content) {
                    if (block.type === 'text') tokens += roughTokenCount(block.text);
                    if (block.type === 'tool_result') {
                        if (typeof block.content === 'string') {
                            tokens += roughTokenCount(block.content);
                        } else {
                            for (const c of block.content) {
                                if (c.type === 'text') tokens += roughTokenCount(c.text);
                                // Image tokens can't be derived from base64 length; use ~1200 as a rough upper bound.
                                else if (c.type === 'image') tokens += 1200;
                            }
                        }
                    }
                }
            }
        } else if (msg.type === 'assistant') {
            if (typeof msg.message.content === 'string') {
                tokens += roughTokenCount(msg.message.content);
            } else {
                for (const block of msg.message.content) {
                    if (block.type === 'text') tokens += roughTokenCount(block.text);
                    if (block.type === 'tool_use') tokens += roughTokenCount(JSON.stringify(block.input));
                }
            }
        }
    }
    return tokens;
}

const ERROR_THRESHOLD_BUFFER = 20000;

export async function autoCompactIfNeeded(
    messages: Message[],
    provider: ChatProvider,
    contextWindowSize: number = 100000
): Promise<{ wasCompacted: boolean, messages: Message[] }> {
    const currentTokens = estimateMessageTokens(messages);
    const threshold = contextWindowSize - ERROR_THRESHOLD_BUFFER;

    if (currentTokens < threshold) {
        return { wasCompacted: false, messages };
    }

    // Token limit breached. We must AutoCompact.
    // Take the oldest 50% of the conversation (excluding system prompt).
    const systemMsgs = messages.filter(m => m.type === 'system');
    const conversation = messages.filter(m => m.type !== 'system');
    
    const sliceIndex = Math.max(1, Math.floor(conversation.length / 2));
    const oldMessages = conversation.slice(0, sliceIndex);
    const keptMessages = conversation.slice(sliceIndex);

    // Summarize the old messages via LLM. Cap the input to avoid exceeding the summarizer's own context.
    const rawJson = JSON.stringify(oldMessages, null, 2);
    const maxSummaryInputChars = 60000; // ~15k tokens
    const truncatedJson = rawJson.length > maxSummaryInputChars
        ? rawJson.slice(0, maxSummaryInputChars) + '\n...[truncated]'
        : rawJson;
    const summaryPrompt = 'Please read the following conversation logs and provide a highly detailed, dense technical summary of what was accomplished, what code was written, and any important context or decisions made. Retain file paths, exact error messages, and critical commands.\n\n' + truncatedJson;

    let summaryText = '';
    try {
        const stream = provider.chat({
            system: "You are an expert context summarizer.",
            messages: [{ type: 'user', uuid: randomUUID(), message: { content: summaryPrompt } }],
            tools: [],
            maxTokens: 4000,
            temperature: 0,
            forceToolUse: false
        });

        for await (const chunk of stream) {
            if (chunk.type === 'content_block_delta' && 'text' in chunk.delta) {
                summaryText += chunk.delta.text;
            }
        }
    } catch (e) {
        console.warn("[AutoCompact] Summarization failed, falling back to basic dropped boundary", e);
        summaryText = "[Summarization failed due to API error. Messages were dropped.]";
    }

    const summarySysMsg: SystemMessage = {
        type: 'system',
        uuid: randomUUID(),
        subtype: 'compact_boundary',
        content: `[CONTEXT COMPACTED]:\nThe older half of this conversation was summarized by the LLM to save tokens. Summary below:\n\n${summaryText}`
    };
    
    bus.emit('context.compacted', { 
        tokensSaved: currentTokens - estimateMessageTokens([...systemMsgs, summarySysMsg, ...keptMessages]),
        summary: summaryText 
    });

    return {
        wasCompacted: true,
        messages: [...systemMsgs, summarySysMsg, ...keptMessages]
    };
}
