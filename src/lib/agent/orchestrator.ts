/**
 * Axiom Agent — Orchestrator
 *
 * Entry point that:
 * 1. Resolves the AI provider with auto-fallback
 * 2. Loads dynamic tools and MCP tools
 * 3. Injects skills into the system prompt
 * 4. Builds per-provider system prompt
 * 5. Auto-captures snapshot before agent loop
 * 6. Runs the manual agentic loop (no Vercel AI SDK)
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { resolveProvider, PROVIDERS, type ProviderId } from './providers';
import { buildSystemPrompt, MODE_CREDIT_MULTIPLIER, type GameMode } from './prompts';
import { detectSkill } from './skills';
import { runAgentLoop as runLoop, type AgentResult } from './loop';
import { SnapshotManager } from '../snapshot';
import { SkillsManager } from '../skills';
import { scanAndRegisterTools } from '../tools/dynamic';
import { mcpManager } from '../mcp';
import { bus } from '../bus';
import type { ToolResult, ToolFileData } from '@/types/agent';
import type { ToolContext } from './tools';
import { executeTool } from './tools';

// Ensure all tools are registered
import './tools';

// Re-export for route.ts compatibility
export { MODE_CREDIT_MULTIPLIER };
export const PROVIDER_INFO = PROVIDERS;
export type AgentProvider = ProviderId;
export type { GameMode, AgentResult };

// ── Initialization (runs once on first import) ─────────────────────

let _initialized = false;

async function initializeSubsystems() {
    if (_initialized) return;
    _initialized = true;

    try {
        const count = await scanAndRegisterTools();
        if (count > 0) {
            bus.emit('tool.complete', {
                toolName: 'dynamic:init',
                success: true,
                duration_ms: 0,
                callId: `init_${Date.now()}`,
            });
        }
    } catch (err) {
        console.error('[Orchestrator] Dynamic tools scan failed:', err);
    }
}

// ── Main Entry Point ────────────────────────────────────────────────

export async function runAgentLoop(params: {
    message: string;
    projectId: string;
    userId: string;
    supabase: SupabaseClient;
    conversationId: string;
    gameMode: GameMode;
    provider?: AgentProvider;
    onToolStart?: (toolName: string, input: Record<string, unknown>, callId: string) => void;
    onToolResult?: (toolName: string, result: ToolResult) => void;
    onIteration?: (iteration: number) => void;
    onReasoning?: (reasoning: string) => void;
    onText?: (text: string) => void;
}): Promise<AgentResult> {
    const { message, projectId, userId, supabase, gameMode } = params;

    await initializeSubsystems();

    bus.emit('agent.start', {
        sessionId: params.conversationId,
        agentType: 'build',
    });

    // 1. Resolve provider with auto-fallback
    const resolved = resolveProvider((params.provider ?? 'claude') as ProviderId);
    if (!resolved) {
        return {
            response: `No AI provider configured. Add at least one API key: ${Object.values(PROVIDERS).map(p => `${p.label} (${p.envKey})`).join(', ')}.`,
            toolCalls: [],
            totalTokens: 0,
            iterations: 0,
        };
    }

    const { provider, config } = resolved;
    console.log(`[Orchestrator] provider=${config.id} model=${config.modelId}`);

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

    // 3. Build per-provider system prompt
    let systemPrompt = buildSystemPrompt(fileList, conversationHistory, gameMode, config.id);

    // 4. Inject active skills into system prompt
    try {
        const skillsMgr = new SkillsManager(process.cwd());
        const activeFiles = (files ?? []).map(f => f.path);
        const skillsInjection = skillsMgr.buildPromptInjection(activeFiles);
        if (skillsInjection) {
            systemPrompt += '\n' + skillsInjection;
        }
    } catch (err) {
        console.error('[Orchestrator] Skills injection failed:', err);
    }

    // 5. Inject MCP tools info into system prompt
    try {
        const mcpTools = mcpManager.getTools();
        if (mcpTools.length > 0) {
            const mcpSection = mcpTools.map(t => `- ${t.name}: ${t.description}`).join('\n');
            systemPrompt += `\n\n## Available MCP Tools\n${mcpSection}`;
        }
    } catch { /* MCP not configured */ }

    // 6. Build tool context
    const toolCtx: ToolContext = {
        projectId,
        userId,
        supabase,
        createdFiles: [] as ToolFileData[],
    };

    // 7. Detect skill and execute mandatory steps
    const skillMatch = detectSkill(message);
    console.log(`[Orchestrator] skill=${skillMatch ? skillMatch.skill.name : 'none'} mandatory=${skillMatch?.skill.mandatory ?? false}`);
    let userMessage = message;
    const skillResults: Array<{ tool: string; description: string; success: boolean; filesModified: string[] }> = [];

    if (skillMatch) {
        const skillParams = {
            gameName: skillMatch.params.gameName ?? 'My Game',
            gameDescription: skillMatch.params.gameDescription ?? message,
            gameMode,
        };
        const steps = skillMatch.skill.steps(skillParams);

        if (skillMatch.skill.mandatory) {
            for (const step of steps) {
                const stepCallId = `skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                params.onToolStart?.(step.tool, step.input, stepCallId);
                toolCtx.createdFiles = [];
                const result = await executeTool(step.tool, step.input, toolCtx);
                result.callId = stepCallId;
                params.onToolResult?.(step.tool, result);
                skillResults.push({
                    tool: step.tool,
                    description: step.description,
                    success: result.success,
                    filesModified: result.filesModified ?? [],
                });
            }

            const summary = skillResults
                .map((r, i) => `${i + 1}. ${r.tool}: ${r.success ? '✓' : '✗'} ${r.description}${r.filesModified.length > 0 ? ` → ${r.filesModified.join(', ')}` : ''}`)
                .join('\n');
            userMessage = `[SKILL EXECUTED: ${skillMatch.skill.name}]\nThe following files were already created:\n${summary}\n\nProvide a brief summary of what was built. If the user asked for something specific that the skill didn't cover, add 1-2 extra tool calls. Otherwise just summarize.\n\nUser request: ${message}`;
        } else {
            userMessage = `[SKILL HINT: ${skillMatch.skill.name}]\nRecommended tool execution order:\n${steps.map((s, i) => `${i + 1}. ${s.tool}(${JSON.stringify(s.input)})`).join('\n')}\n\nUser request: ${message}`;
        }
    }

    const mandatorySkillRan = skillMatch?.skill.mandatory && skillResults.length > 0;

    // 8. Auto-capture snapshot
    const snapshotMgr = new SnapshotManager(supabase, projectId);
    const snapshotId = await snapshotMgr.capture(`pre-agent-${Date.now()}`).catch(() => null);

    // 9. Build conversation history
    const historyMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (history?.length) {
        for (const h of history) {
            const role = h.role as string;
            if (role === 'user' || role === 'assistant') {
                historyMessages.push({
                    role: role as 'user' | 'assistant',
                    content: (h.content as string).slice(0, 2000),
                });
            }
        }
    }

    // 10. Run the agent loop
    const result = await runLoop({
        provider,
        systemPrompt,
        userMessage,
        agentType: 'build',
        toolCtx,
        callbacks: {
            onToolStart: params.onToolStart,
            onToolResult: params.onToolResult,
            onIteration: params.onIteration,
            onReasoning: params.onReasoning,
            onText: params.onText,
        },
        historyMessages,
        skipForceFirstTool: mandatorySkillRan,
        maxIterations: mandatorySkillRan ? 5 : undefined,
    });

    // 11. Emit agent completion event
    bus.emit('agent.complete', {
        sessionId: params.conversationId,
        response: result.response,
        totalTokens: result.totalTokens,
        iterations: result.iterations,
    });

    // 12. Post-run snapshot diff
    if (snapshotId) {
        try {
            const diffs = await snapshotMgr.diff(snapshotId);
            if (diffs.length > 0) {
                bus.emit('tool.complete', {
                    toolName: 'snapshot.diff',
                    success: true,
                    duration_ms: 0,
                    callId: snapshotId,
                });
            }
        } catch { /* snapshot diff failed, non-critical */ }
    }

    return result;
}
