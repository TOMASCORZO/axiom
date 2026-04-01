import { Message, SystemMessage } from '../../../types/agent';
import { randomUUID } from 'crypto';

/**
 * Snip Compact permanently removes intermediate conversation turns (user/assistant pairs)
 * while preserving the system prompt and the most recent N turns.
 * 
 * Replaces the dropped section with a `compact_boundary` system message.
 */
export function snipCompact(messages: Message[], keepLastNTurns: number = 4): Message[] {
    if (messages.length <= keepLastNTurns * 2 + 1) {
        return messages; // Not enough history to warrant snipping
    }

    const systemMsgs = messages.filter(m => m.type === 'system');
    const conversation = messages.filter(m => m.type !== 'system');

    // Identify the last N turns. A 'turn' is roughly an assistant-user exchange.
    const keepFromIndex = Math.max(0, conversation.length - (keepLastNTurns * 2));

    const keptConversation = conversation.slice(keepFromIndex);
    const droppedCount = conversation.length - keptConversation.length;

    if (droppedCount === 0) return messages;

    const boundaryMsg: SystemMessage = {
        type: 'system',
        uuid: randomUUID(),
        subtype: 'compact_boundary',
        content: `[System Note: ${droppedCount} intermediate messages have been snipped/removed from the context to save tokens.]`
    };

    return [
        ...systemMsgs,
        boundaryMsg,
        ...keptConversation
    ];
}
