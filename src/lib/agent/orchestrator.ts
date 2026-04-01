/**
 * Axiom Agent — Orchestrator
 *
 * Entry point that:
 * 1. Resolves the AI provider with auto-fallback
 * 2. Loads dynamic tools and MCP tools
 * 3. Injects skills into the system prompt
 * 4. Builds per-provider system prompt
 * 5. Auto-captures snapshot before agent loop
 * 6. Runs the QueryEngine-backed agentic loop
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { resolveProvider, type ProviderId } from './providers';
import { buildSystemPrompt, MODE_CREDIT_MULTIPLIER, type GameMode } from './prompts';
import { detectSkill } from './skills';
import { runAgentLoop as runLoop, type AgentResult } from './loop';
import { SnapshotManager } from '../snapshot';
import { SkillsManager } from '../skills';
import { scanAndRegisterTools } from '../tools/dynamic';
import { mcpManager } from '../mcp';
import { bus } from '../bus';
import type { ToolResult, ToolFileData, Message } from '../../types/agent';
import type { ToolContext } from './tools';
import { executeTool, getToolSchemas } from './tools';
import { buildContextPrompt } from './context';
import { handleSlashCommand } from './commands';
import { randomUUID } from 'crypto';

// Ensure all tools are registered
import './tools';

// Re-export for route.ts compatibility
export { MODE_CREDIT_MULTIPLIER };
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

// ── Helpers ──────────────────────────────────────────────────────────

function buildHistoryMessages(
    history: Array<{ role: string; content: string }> | null
): Message[] {
    if (!history?.length) return [];
    const messages: Message[] = [];
    for (const h of history) {
        const role = h.role as string;
        if (role === 'user') {
            messages.push({
                type: 'user',
                uuid: randomUUID(),
                message: { content: (h.content ?? '').slice(0, 2000) }
            });
        } else if (role === 'assistant') {
            messages.push({
                type: 'assistant',
                uuid: randomUUID(),
                message: { content: [{ type: 'text', text: (h.content ?? '').slice(0, 2000) }] }
            });
        }
    }
    return messages;
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

    // 0. Fetch conversation history early so slash commands can use it
    const { data: rawHistory } = await supabase
        .from('agent_logs')
        .select('role, content')
        .eq('conversation_id', params.conversationId)
        .order('created_at', { ascending: true })
        .limit(20);

    const historyMessages = buildHistoryMessages(rawHistory as Array<{ role: string; content: string }> | null);

    // 1. Intercept Slash Commands (with real history)
    try {
        const slashResult = await handleSlashCommand(message, params.conversationId, historyMessages);
        if (slashResult.intercepted) {
            return {
                response: slashResult.output,
                toolCalls: [],
                totalTokens: 0,
                iterations: 0,
            };
        }
    } catch (err) {
        console.error('[Orchestrator] Slash command error:', err);
    }

    await initializeSubsystems();

    bus.emit('agent.start', {
        sessionId: params.conversationId,
        agentType: 'build',
    });

    // 2. Resolve provider with auto-fallback
    const resolved = resolveProvider((params.provider ?? 'claude') as ProviderId);
    if (!resolved) {
        return {
            response: 'No AI provider configured. Add at least one API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, or MOONSHOT_API_KEY).',
            toolCalls: [],
            totalTokens: 0,
            iterations: 0,
        };
    }

    const { provider, config } = resolved;
    console.log(`[Orchestrator] provider=${config.id} model=${config.modelId}`);

    // 3. Fetch project files
    const { data: files } = await supabase
        .from('project_files')
        .select('path, content_type, size_bytes')
        .eq('project_id', projectId)
        .order('path');

    const fileList = (files ?? []).map((f: any) => `  ${f.path} (${f.content_type}, ${f.size_bytes ?? 0}B)`).join('\n');

    // 4. Build per-provider system prompt
    let systemPrompt = buildSystemPrompt(fileList, '', gameMode, config.id);

    // 4.5 Inject Dynamic Git/OS Context
    try {
        systemPrompt += '\n\n' + buildContextPrompt(process.cwd());
    } catch (err) {
        console.error('[Orchestrator] Context injection failed:', err);
    }

    // 5. Inject active skills into system prompt
    try {
        const skillsMgr = new SkillsManager(process.cwd());
        const activeFiles = (files ?? []).map((f: any) => f.path);
        const skillsInjection = skillsMgr.buildPromptInjection(activeFiles);
        if (skillsInjection) {
            systemPrompt += '\n' + skillsInjection;
        }
    } catch (err) {
        console.error('[Orchestrator] Skills injection failed:', err);
    }

    // 6. Inject MCP tools info into system prompt
    try {
        const mcpTools = mcpManager.getTools();
        if (mcpTools.length > 0) {
            const mcpSection = mcpTools.map((t: any) => `- ${t.name}: ${t.description}`).join('\n');
            systemPrompt += `\n\n## Available MCP Tools\n${mcpSection}`;
        }
    } catch { /* MCP not configured */ }

    // 7. Build tool context
    const toolCtx: ToolContext = {
        projectId,
        userId,
        supabase,
        createdFiles: [] as ToolFileData[],
    };

    // 8. Detect skill and execute mandatory steps
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

    // 9. Auto-capture snapshot
    const snapshotMgr = new SnapshotManager(supabase, projectId);
    const snapshotId = await snapshotMgr.capture(`pre-agent-${Date.now()}`).catch(() => null);

    // 10. Convert Message[] history to the legacy format loop.ts expects
    const legacyHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const msg of historyMessages) {
        if (msg.type === 'user') {
            const content = typeof msg.message.content === 'string'
                ? msg.message.content
                : msg.message.content.filter(b => b.type === 'text').map(b => (b as any).text).join('\n');
            legacyHistory.push({ role: 'user', content });
        } else if (msg.type === 'assistant') {
            const content = msg.message.content.filter(b => b.type === 'text').map(b => (b as any).text).join('\n');
            legacyHistory.push({ role: 'assistant', content });
        }
    }

    // 11. Run the agent loop
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
        historyMessages: legacyHistory,
        skipForceFirstTool: mandatorySkillRan,
        maxIterations: mandatorySkillRan ? 5 : undefined,
    });

    // 12. Emit agent completion event
    bus.emit('agent.complete', {
        sessionId: params.conversationId,
        response: result.response,
        totalTokens: result.totalTokens,
        iterations: result.iterations,
    });

    // 13. Post-run snapshot diff
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

// ── Streaming Entry Point (Phase 5) ─────────────────────────────────

import { QueryEngine } from './engine/QueryEngine';

export async function prepareQueryEngine(params: {
    message: string;
    projectId: string;
    userId: string;
    supabase: SupabaseClient;
    conversationId: string;
    gameMode: GameMode;
    provider?: AgentProvider;
    callbacks?: any;
}) {
    const { message, projectId, userId, supabase, gameMode, callbacks } = params;

    const { data: rawHistory } = await supabase
        .from('agent_logs')
        .select('role, content')
        .eq('conversation_id', params.conversationId)
        .order('created_at', { ascending: true })
        .limit(20);

    const historyMessages = buildHistoryMessages(rawHistory as Array<{ role: string; content: string }> | null);

    // Skip slash commands intercept inside the engine initialization for now, 
    // or handle it in route.ts. For CC parity, slash commands are handled locally by the ChatInput or Engine.

    const resolved = resolveProvider((params.provider ?? 'claude') as ProviderId);
    if (!resolved) throw new Error('No AI provider configured.');
    const { provider, config } = resolved;

    const { data: files } = await supabase
        .from('project_files')
        .select('path, content_type, size_bytes')
        .eq('project_id', projectId)
        .order('path');
    const fileList = (files ?? []).map((f: any) => `  ${f.path} (${f.content_type}, ${f.size_bytes ?? 0}B)`).join('\n');

    let systemPrompt = buildSystemPrompt(fileList, '', gameMode, config.id);
    try { systemPrompt += '\n\n' + buildContextPrompt(process.cwd()); } catch (err) {}
    try {
        const mcpTools = mcpManager.getTools();
        if (mcpTools.length > 0) {
            systemPrompt += `\n\n## Available MCP Tools\n${mcpTools.map((t: any) => `- ${t.name}: ${t.description}`).join('\n')}`;
        }
    } catch {}

    const toolCtx: ToolContext = { projectId, userId, supabase, createdFiles: [] };

    // Note: Skipping mandatory skill pre-execution here to maintain pure CC parity, 
    // but preserving history.

    const engine = new QueryEngine({
        provider,
        systemPrompt,
        tools: getToolSchemas('build'),
        maxTokens: 8000,
        toolCtx,
        callbacks,
    }, historyMessages);

    return { engine, resolvedConfig: config };
}
