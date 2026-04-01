/**
 * Event Bus — Typed Pub/Sub system for Axiom.
 *
 * OpenCode pattern: Decouple the agent orchestrator from UI/plugins/logging
 * by emitting typed events that any subscriber can react to asynchronously
 * without blocking the ReAct loop.
 *
 * Usage:
 *   import { bus } from '@/lib/bus';
 *
 *   // Subscribe
 *   const unsub = bus.on('tool.start', (payload) => { ... });
 *
 *   // Emit
 *   bus.emit('tool.start', { toolName: 'edit_file', input: { ... } });
 *
 *   // Cleanup
 *   unsub();
 */

// ── Event Type Definitions ──────────────────────────────────────────

export interface BusEvents {
    // Agent lifecycle
    'agent.start': { sessionId: string; agentType: string };
    'agent.complete': { sessionId: string; response: string; totalTokens: number; iterations: number };
    'agent.error': { sessionId: string; error: string };

    // Iteration lifecycle
    'iteration.start': { iteration: number };
    'iteration.complete': { iteration: number };

    // Tool lifecycle
    'tool.start': { toolName: string; input: Record<string, unknown>; callId?: string };
    'tool.complete': { toolName: string; success: boolean; duration_ms: number; callId?: string; truncated?: boolean };
    'tool.error': { toolName: string; error: string; callId?: string };

    // LLM streaming
    'model.reasoning': { text: string };
    'model.text': { text: string };
    'model.tokens': { inputTokens: number; outputTokens: number };

    // Safety
    'doom_loop.detected': { toolName: string; count: number };
    'truncation.applied': { toolName: string; originalLength: number; truncatedLength: number };
    'context.compacted': { tokensSaved: number; summary: string };

    // Permission (for future Phase 1.3)
    'permission.request': { toolName: string; permission: string; patterns: string[] };
    'permission.response': { toolName: string; granted: boolean };
}

// ── Bus Implementation ──────────────────────────────────────────────

type EventName = keyof BusEvents;
type Listener<T extends EventName> = (payload: BusEvents[T]) => void;

class EventBus {
    private listeners = new Map<string, Set<Function>>();
    private wildcardListeners = new Set<(event: string, payload: unknown) => void>();

    /**
     * Subscribe to a specific event type.
     * Returns an unsubscribe function.
     */
    on<T extends EventName>(event: T, listener: Listener<T>): () => void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event)!.add(listener);

        return () => {
            this.listeners.get(event)?.delete(listener);
        };
    }

    /**
     * Subscribe to ALL events (wildcard).
     * Useful for logging, telemetry, or UI streaming.
     */
    onAll(listener: (event: string, payload: unknown) => void): () => void {
        this.wildcardListeners.add(listener);
        return () => {
            this.wildcardListeners.delete(listener);
        };
    }

    /**
     * Emit an event. All listeners are called asynchronously (non-blocking).
     * Errors in listeners are caught and logged, never propagated to the emitter.
     */
    emit<T extends EventName>(event: T, payload: BusEvents[T]): void {
        // Specific listeners
        const listeners = this.listeners.get(event);
        if (listeners) {
            for (const listener of listeners) {
                try {
                    listener(payload);
                } catch (err) {
                    console.error(`[EventBus] Error in listener for "${event}":`, err);
                }
            }
        }

        // Wildcard listeners
        for (const listener of this.wildcardListeners) {
            try {
                listener(event, payload);
            } catch (err) {
                console.error(`[EventBus] Error in wildcard listener for "${event}":`, err);
            }
        }
    }

    /**
     * Remove all listeners. Useful for cleanup/testing.
     */
    clear(): void {
        this.listeners.clear();
        this.wildcardListeners.clear();
    }

    /**
     * Get the count of listeners for a specific event (for debugging).
     */
    listenerCount(event?: EventName): number {
        if (event) {
            return (this.listeners.get(event)?.size ?? 0) + this.wildcardListeners.size;
        }
        let total = this.wildcardListeners.size;
        for (const set of this.listeners.values()) {
            total += set.size;
        }
        return total;
    }
}

// ── Singleton Export ─────────────────────────────────────────────────

/** Global event bus instance — the single source of truth for Axiom events */
export const bus = new EventBus();

export type { EventName, Listener };
export { EventBus };
