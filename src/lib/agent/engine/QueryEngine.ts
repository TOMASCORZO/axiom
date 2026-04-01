import { Message, AssistantMessage, StreamEvent } from '../../../types/agent';
import { queryLoop, QueryOptions } from './query';
import { randomUUID } from 'crypto';

/**
 * QueryEngine acts as the stateful orchestrator of the conversation session.
 * It manages the history log, abort control, and exposes the `submitMessage` facade.
 */
export class QueryEngine {
    private messages: Message[] = [];
    private options: Omit<QueryOptions, 'systemPrompt'> & { systemPrompt: string };
    private abortController: AbortController;

    constructor(options: typeof QueryEngine.prototype.options, initialHistory: Message[] = []) {
        this.options = options;
        this.messages = initialHistory;
        this.abortController = new AbortController();
    }

    /**
     * Pushes a new user string, then iterates the queryLoop until the agent resolves.
     */
    public async *submitMessage(userStr: string): AsyncGenerator<StreamEvent, { messages: Message[], assistantMsg: AssistantMessage, iterations: number }, unknown> {
        this.messages.push({
            type: 'user',
            uuid: randomUUID(),
            message: { content: userStr }
        });

        const loopGen = queryLoop(this.messages, {
            ...this.options,
            abortController: this.abortController,
        });

        let result: { assistantMessage: AssistantMessage, newMessages: Message[], iterations: number } | undefined;

        while (true) {
            const { value, done } = await loopGen.next();
            if (done) {
                result = value;
                break;
            }
            yield value as StreamEvent;
        }

        if (result) {
            this.messages = result.newMessages;
            return {
                messages: this.messages,
                assistantMsg: result.assistantMessage,
                iterations: result.iterations
            };
        }

        throw new Error('Query loop terminated unexpectedly');
    }

    /**
     * Abort the current in-flight query. The loop will stop at the next check point.
     */
    public abort(): void {
        this.abortController.abort();
        // Create a fresh controller for the next query
        this.abortController = new AbortController();
    }

    public getMessages(): Message[] {
        return this.messages;
    }
}
