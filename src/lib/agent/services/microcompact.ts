import { Message, UserMessage } from '../../../types/agent';

export const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]';

const COMPACTABLE_TOOLS = new Set([
    'bash', 'file_read', 'grep_search', 'read_url_content', 'find_by_name',
    'search_web', 'read_terminal'
]);

/**
 * Microcompacting clears the content of older, verbose tool results
 * while keeping the history of the tool call itself.
 * This mirrors Claude Code's `maybeTimeBasedMicrocompact`.
 *
 * @param messages The full conversation history
 * @param keepRecent The number of recent compactable tool results to preserve
 */
export function microcompactMessages(messages: Message[], keepRecent: number = 3): Message[] {
    const compactableIds: string[] = [];

    // First pass: identify all compactable tool result IDs in order
    for (const msg of messages) {
        if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
            for (const block of msg.message.content) {
                if (block.type === 'tool_use' && COMPACTABLE_TOOLS.has(block.name)) {
                    compactableIds.push(block.id);
                }
            }
        }
    }

    if (compactableIds.length <= keepRecent) {
        return messages; // Nothing to microcompact
    }

    // Determine which ones to clear
    const keepSet = new Set(compactableIds.slice(-keepRecent));
    const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)));

    // Second pass: apply the content clearing
    return messages.map(msg => {
        if (msg.type !== 'user' || typeof msg.message.content === 'string') {
            return msg;
        }

        let touched = false;
        const newContent = msg.message.content.map(block => {
            if (
                block.type === 'tool_result' && 
                clearSet.has(block.tool_use_id) && 
                block.content !== TIME_BASED_MC_CLEARED_MESSAGE
            ) {
                touched = true;
                return { ...block, content: TIME_BASED_MC_CLEARED_MESSAGE };
            }
            return block;
        });

        if (!touched) return msg;

        return {
            ...msg,
            message: { ...msg.message, content: newContent }
        } as UserMessage;
    });
}
