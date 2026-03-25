import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { runAgentLoop, MODE_CREDIT_MULTIPLIER, type GameMode, type AgentProvider } from '@/lib/agent/orchestrator';
import { v4 as uuid } from 'uuid';

// Vercel Serverless Function config — agent loop needs extended timeout
export const maxDuration = 60;

// GET /api/agent/chat — Debug: check env vars availability
export async function GET() {
    return NextResponse.json({
        moonshot: !!process.env.MOONSHOT_API_KEY,
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        openai: !!process.env.OPENAI_API_KEY,
        moonshot_prefix: process.env.MOONSHOT_API_KEY?.slice(0, 6) ?? 'MISSING',
    });
}

// POST /api/agent/chat — Full AI agent with ReAct tool execution loop
export async function POST(request: NextRequest) {
    try {
        const supabase = await createServerSupabaseClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const { project_id, message, conversation_id, game_mode, provider: rawProvider } = body;
        const gameMode: GameMode = game_mode === '3d' ? '3d' : '2d';
        const provider: AgentProvider = ['claude', 'gpt', 'kimi'].includes(rawProvider) ? rawProvider : 'claude';
        const creditMultiplier = MODE_CREDIT_MULTIPLIER[gameMode];

        if (!project_id || !message) {
            return NextResponse.json(
                { error: 'project_id and message are required' },
                { status: 400 },
            );
        }

        // Check AI credits
        const { data: profile } = await supabase
            .from('profiles')
            .select('ai_credits_remaining')
            .eq('id', user.id)
            .single();

        if (!profile || profile.ai_credits_remaining <= 0) {
            return NextResponse.json(
                { error: 'No AI credits remaining. Please upgrade your plan.' },
                { status: 429 },
            );
        }

        const convId = conversation_id || uuid();

        // Log the user message
        await supabase.from('agent_logs').insert({
            project_id,
            user_id: user.id,
            conversation_id: convId,
            role: 'user',
            content: message,
        });

        // Run the full agent loop
        const toolCallsForClient: Array<{
            id: string;
            name: string;
            status: 'completed' | 'failed';
            input: Record<string, unknown>;
            output?: Record<string, unknown>;
            error?: string;
            filesModified?: string[];
        }> = [];

        const agentResult = await runAgentLoop({
            message,
            projectId: project_id,
            userId: user.id,
            supabase,
            conversationId: convId,
            gameMode,
            provider,
            onToolStart: (toolName, input) => {
                toolCallsForClient.push({
                    id: uuid(),
                    name: toolName,
                    status: 'completed', // Will be updated
                    input,
                });
            },
            onToolResult: (toolName, result) => {
                const last = toolCallsForClient[toolCallsForClient.length - 1];
                if (last && last.name === toolName) {
                    last.status = result.success ? 'completed' : 'failed';
                    last.output = result.output;
                    last.error = result.error;
                    last.filesModified = result.filesModified;
                }

                // Log tool calls
                supabase.from('agent_logs').insert({
                    project_id,
                    user_id: user.id,
                    conversation_id: convId,
                    role: 'tool_call',
                    content: `${toolName}: ${result.success ? 'OK' : 'FAIL'}`,
                    tool_name: toolName,
                    tool_input: last?.input ?? {},
                    tool_output: result.output,
                    tokens_used: 0,
                    duration_ms: result.duration_ms,
                }).then(() => { });
            },
        });

        // Log the assistant response
        await supabase.from('agent_logs').insert({
            project_id,
            user_id: user.id,
            conversation_id: convId,
            role: 'assistant',
            content: agentResult.response,
            tokens_used: agentResult.totalTokens,
        });

        // Deduct credits (1 per iteration)
        const creditsToDeduct = Math.max(1, agentResult.iterations) * creditMultiplier;
        await supabase.rpc('decrement_credits', { uid: user.id, amount: creditsToDeduct });

        return NextResponse.json({
            conversation_id: convId,
            response: {
                id: uuid(),
                role: 'assistant',
                content: agentResult.response,
                toolCalls: toolCallsForClient,
                timestamp: new Date().toISOString(),
            },
            game_mode: gameMode,
            meta: {
                iterations: agentResult.iterations,
                totalTokens: agentResult.totalTokens,
                creditsUsed: creditsToDeduct,
                toolsExecuted: toolCallsForClient.length,
            },
        });
    } catch (err) {
        console.error('Agent chat error:', err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Internal server error' },
            { status: 500 },
        );
    }
}
