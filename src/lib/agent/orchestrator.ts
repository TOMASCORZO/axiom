/**
 * Axiom Agent — Orchestrator (OpenCode-faithful)
 *
 * Entry point that:
 * 1. Resolves the AI provider (with auto-fallback)
 * 2. Builds per-provider system prompt (OpenCode pattern)
 * 3. Detects Godogen-style skills for multi-step generation
 * 4. Delegates to processGeneration (the ReAct loop)
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { resolveProvider, PROVIDER_INFO, type AgentProvider } from './providers';
import { buildSystemPrompt, MODE_CREDIT_MULTIPLIER, type GameMode } from './prompts';
import { detectSkill } from './skills';
import { processGeneration, type AgentResult } from './agents/loop';
import type { ToolResult, ToolFileData } from '@/types/agent';
import type { ToolContext } from './tools';

// Ensure all tools are registered
import './tools';

export { MODE_CREDIT_MULTIPLIER, PROVIDER_INFO };
export type { GameMode, AgentProvider, AgentResult };

export async function runAgentLoop(params: {
    message: string;
    projectId: string;
    userId: string;
    supabase: SupabaseClient;
    conversationId: string;
    gameMode: GameMode;
    provider?: AgentProvider;
    onToolStart?: (toolName: string, input: Record<string, unknown>) => void;
    onToolResult?: (toolName: string, result: ToolResult) => void;
    onIteration?: (iteration: number) => void;
    onReasoning?: (reasoning: string) => void;
}): Promise<AgentResult> {
    const { message, projectId, userId, supabase, gameMode } = params;

    // 1. Resolve provider with auto-fallback
    const resolved = resolveProvider(params.provider ?? 'claude');
    if (!resolved) {
        return {
            response: `No AI provider configured. Add at least one API key: ${Object.values(PROVIDER_INFO).map(p => `${p.label} (${p.envKey})`).join(', ')}.`,
            toolCalls: [],
            totalTokens: 0,
            iterations: 0,
        };
    }

    const { adapter, apiKey, provider: resolvedProvider } = resolved;

    // 2. Fetch project state and conversation history in parallel
    const [{ data: files }, { data: history }] = await Promise.all([
        supabase
            .from('project_files')
            .select('path, content_type, size_bytes')
            .eq('project_id', projectId)
            .order('path'),
        supabase
            .from('agent_logs')
            .select('role, content')
            .eq('conversation_id', params.conversationId)
            .order('created_at', { ascending: true })
            .limit(20),
    ]);

    const fileList = (files ?? []).map(f => `  ${f.path} (${f.content_type}, ${f.size_bytes ?? 0}B)`).join('\n');
    const conversationHistory = (history ?? [])
        .map(h => `${h.role}: ${(h.content as string).slice(0, 300)}`)
        .join('\n');

    // 3. Build per-provider system prompt (OpenCode pattern)
    const systemPrompt = buildSystemPrompt(fileList, conversationHistory, gameMode, resolvedProvider);

    // 4. Detect Godogen-style skill
    const skillMatch = detectSkill(message);
    let userMessage = message;

    if (skillMatch) {
        const steps = skillMatch.skill.steps({
            gameName: skillMatch.params.gameName ?? 'My Game',
            gameDescription: skillMatch.params.gameDescription ?? message,
            gameMode,
        });
        userMessage = `[SKILL HINT: ${skillMatch.skill.name}]\nRecommended tool execution order:\n${steps.map((s, i) => `${i + 1}. ${s.tool}(${JSON.stringify(s.input)})`).join('\n')}\n\nUser request: ${message}`;
    }

    // 5. Build tool context
    const toolCtx: ToolContext = {
        projectId,
        userId,
        supabase,
        createdFiles: [] as ToolFileData[],
    };

    // 6. Run the agent loop
    return processGeneration({
        adapter,
        config: { apiKey, model: adapter.model, maxTokens: 4096 },
        systemPrompt,
        userMessage,
        agentType: 'build',
        toolCtx,
        callbacks: {
            onToolStart: params.onToolStart,
            onToolResult: params.onToolResult,
            onIteration: params.onIteration,
            onReasoning: params.onReasoning,
        },
    });
}
