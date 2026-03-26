/**
 * Session Manager — Sub-agent session bifurcation for Axiom.
 *
 * OpenCode pattern: When the main agent needs specialized help (explore,
 * build a component, analyze code), it spawns a child session with:
 * - Its own session ID in the database
 * - A clean message history (fresh memory)
 * - A specialized system prompt
 * - A parent reference for result propagation
 *
 * When the child completes, it returns a compressed <task_result>
 * to the parent instead of the full conversation history.
 *
 * Usage:
 *   import { SessionManager } from '@/lib/session';
 *
 *   const mgr = new SessionManager(supabase);
 *   const child = await mgr.fork({
 *     parentSessionId: 'abc-123',
 *     agentType: 'explore',
 *     task: 'Find all files that reference PlayerController',
 *     projectId: 'project-456',
 *     userId: 'user-789',
 *   });
 */

import { type SupabaseClient } from '@supabase/supabase-js';
import { bus } from '../bus';

// ── Types ───────────────────────────────────────────────────────────

export interface Session {
    id: string;
    parentId: string | null;
    projectId: string;
    userId: string;
    agentType: string;
    status: 'active' | 'completed' | 'failed';
    task: string;
    result: string | null;
    createdAt: string;
    completedAt: string | null;
    metadata: Record<string, unknown>;
}

export interface ForkOptions {
    parentSessionId: string;
    agentType: string;
    task: string;
    projectId: string;
    userId: string;
    /** Additional context to pass to the child (injected into system prompt) */
    context?: string;
    /** Maximum iterations for the child agent */
    maxIterations?: number;
}

// ── Session Manager ─────────────────────────────────────────────────

export class SessionManager {
    constructor(private supabase: SupabaseClient) {}

    /**
     * Create a new root session (top-level conversation).
     */
    async create(params: {
        projectId: string;
        userId: string;
        agentType: string;
    }): Promise<Session> {
        const session: Session = {
            id: crypto.randomUUID(),
            parentId: null,
            projectId: params.projectId,
            userId: params.userId,
            agentType: params.agentType,
            status: 'active',
            task: '',
            result: null,
            createdAt: new Date().toISOString(),
            completedAt: null,
            metadata: {},
        };

        // Persist to Supabase
        await this.persist(session);

        bus.emit('agent.start', {
            sessionId: session.id,
            agentType: params.agentType,
        });

        return session;
    }

    /**
     * Fork a child session from a parent. The child gets:
     * - A new unique session ID
     * - A reference to its parent
     * - Clean message history (no parent context pollution)
     * - Its own agent type and specialized prompt
     */
    async fork(options: ForkOptions): Promise<Session> {
        const session: Session = {
            id: crypto.randomUUID(),
            parentId: options.parentSessionId,
            projectId: options.projectId,
            userId: options.userId,
            agentType: options.agentType,
            status: 'active',
            task: options.task,
            result: null,
            createdAt: new Date().toISOString(),
            completedAt: null,
            metadata: {
                context: options.context ?? null,
                maxIterations: options.maxIterations ?? undefined,
            },
        };

        await this.persist(session);

        bus.emit('agent.start', {
            sessionId: session.id,
            agentType: options.agentType,
        });

        return session;
    }

    /**
     * Complete a session with a result.
     * The result is a compressed summary that gets passed back to the parent.
     */
    async complete(sessionId: string, result: string): Promise<void> {
        const { error } = await this.supabase
            .from('agent_sessions')
            .update({
                status: 'completed',
                result,
                completed_at: new Date().toISOString(),
            })
            .eq('id', sessionId);

        if (error) {
            console.error(`[Session] Failed to complete session ${sessionId}:`, error.message);
        }

        bus.emit('agent.complete', {
            sessionId,
            response: result,
            totalTokens: 0,
            iterations: 0,
        });
    }

    /**
     * Mark a session as failed.
     */
    async fail(sessionId: string, error: string): Promise<void> {
        await this.supabase
            .from('agent_sessions')
            .update({
                status: 'failed',
                result: `[ERROR] ${error}`,
                completed_at: new Date().toISOString(),
            })
            .eq('id', sessionId);

        bus.emit('agent.error', { sessionId, error });
    }

    /**
     * Get a session by ID.
     */
    async get(sessionId: string): Promise<Session | null> {
        const { data } = await this.supabase
            .from('agent_sessions')
            .select('*')
            .eq('id', sessionId)
            .single();

        if (!data) return null;

        return {
            id: data.id,
            parentId: data.parent_id,
            projectId: data.project_id,
            userId: data.user_id,
            agentType: data.agent_type,
            status: data.status,
            task: data.task ?? '',
            result: data.result,
            createdAt: data.created_at,
            completedAt: data.completed_at,
            metadata: data.metadata ?? {},
        };
    }

    /**
     * Get all child sessions of a parent.
     */
    async getChildren(parentSessionId: string): Promise<Session[]> {
        const { data } = await this.supabase
            .from('agent_sessions')
            .select('*')
            .eq('parent_id', parentSessionId)
            .order('created_at', { ascending: true });

        return (data ?? []).map(d => ({
            id: d.id,
            parentId: d.parent_id,
            projectId: d.project_id,
            userId: d.user_id,
            agentType: d.agent_type,
            status: d.status,
            task: d.task ?? '',
            result: d.result,
            createdAt: d.created_at,
            completedAt: d.completed_at,
            metadata: d.metadata ?? {},
        }));
    }

    /**
     * Format a child session's result for injection into the parent's context.
     * OpenCode pattern: <task_result> XML wrapper.
     */
    static formatResult(session: Session): string {
        return `<task_result agent="${session.agentType}" session="${session.id}">
${session.result ?? 'No result available.'}
</task_result>`;
    }

    // ── Internal ────────────────────────────────────────────────────

    private async persist(session: Session): Promise<void> {
        const { error } = await this.supabase
            .from('agent_sessions')
            .upsert({
                id: session.id,
                parent_id: session.parentId,
                project_id: session.projectId,
                user_id: session.userId,
                agent_type: session.agentType,
                status: session.status,
                task: session.task,
                result: session.result,
                created_at: session.createdAt,
                completed_at: session.completedAt,
                metadata: session.metadata,
            }, { onConflict: 'id' });

        if (error) {
            console.error(`[Session] Failed to persist session ${session.id}:`, error.message);
        }
    }
}
