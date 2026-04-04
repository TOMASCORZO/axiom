import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';
import { prepareQueryEngine, MODE_CREDIT_MULTIPLIER, type GameMode, type AgentProvider } from '@/lib/agent/orchestrator';
import { bus } from '@/lib/bus';
import { v4 as uuid } from 'uuid';

// Vercel Serverless Function config
// Streaming functions can run up to 5 min on Hobby, 15 min on Pro
export const maxDuration = 300;

// POST /api/agent/chat — Streaming AI agent with ReAct tool execution loop
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

        if (!project_id || !message) {
            return NextResponse.json(
                { error: 'project_id and message are required' },
                { status: 400 },
            );
        }

        const admin = getAdminClient();

        // TODO: implement sophisticated credit system — disabled for development
        // if (!profile || profile.ai_credits_remaining <= 0) {
        //     return NextResponse.json(
        //         { error: 'No AI credits remaining. Please upgrade your plan.' },
        //         { status: 429 },
        //     );
        // }

        const convId = conversation_id || uuid();

        // Log the user message (fire-and-forget)
        admin.from('agent_logs').insert({
            project_id,
            user_id: user.id,
            conversation_id: convId,
            role: 'user',
            content: message,
        }).then(() => {});

        // Create a readable stream for SSE
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                const sendEvent = (event: string, data: unknown) => {
                    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
                };

                // Bridge Event Bus to SSE stream for live subsystem updates
                const unsubBus = bus.onAll((event, payload) => {
                    if (
                        event === 'truncation.applied' ||
                        event === 'context.compacted' ||
                        event === 'permission.request' ||
                        event === 'doom_loop.detected' ||
                        event === 'tool.complete' ||
                        event === 'agent.start' ||
                        event === 'agent.complete'
                    ) {
                        sendEvent('subsystem', { event, ...payload as object });
                    }
                });

                try {
                    // Send conversation ID immediately
                    sendEvent('init', { conversation_id: convId, game_mode: gameMode });

                    const { engine, resolvedConfig } = await prepareQueryEngine({
                        message,
                        projectId: project_id,
                        userId: user.id,
                        supabase,
                        conversationId: convId,
                        gameMode,
                        provider,
                        callbacks: {
                            onToolStart: (toolName: string, input: any, callId: string) => {
                                sendEvent('tool_start', { id: callId, name: toolName, input });
                            },
                            onToolResult: (toolName: string, result: any) => {
                                sendEvent('tool_result', {
                                    id: result.callId,
                                    name: toolName,
                                    status: result.success ? 'completed' : 'failed',
                                    output: result.output,
                                    error: result.error,
                                    filesModified: result.filesModified,
                                    fileContents: result.fileContents ?? [],
                                });
                            }
                        }
                    });

                    // Native Anthropic Stream
                    const generator = engine.submitMessage(message);

                    let finalResult: { totalTokens: number; iterations: number; toolCalls: number } = { totalTokens: 0, iterations: 1, toolCalls: 0 };
                    let responseMsg = '';

                    for await (const chunk of generator) {
                        // Forward exactly as it came from QueryEngine (Claude Code format)
                        sendEvent('stream_event', chunk);
                        
                        // Accumulate meta info manually if needed
                        if (chunk.type === 'message_delta' && chunk.usage?.outputTokens) {
                            finalResult.totalTokens += chunk.usage.outputTokens;
                        }
                        if (chunk.type === 'content_block_start' && chunk.block.type === 'tool_use') {
                            finalResult.toolCalls++;
                        }
                    }

                    // Log assistant response and deduct credits (fire-and-forget)
                    const creditMultiplier = MODE_CREDIT_MULTIPLIER[gameMode];
                    const creditsToDeduct = Math.max(1, finalResult.iterations) * creditMultiplier;
                    
                    const m = engine.getMessages();
                    const lastAssistant = m[m.length - 1];
                    if (lastAssistant && lastAssistant.type === 'assistant') {
                         responseMsg = lastAssistant.message.content.filter(b => b.type === 'text').map(b => typeof b === 'string' ? b : (b as any).text).join('\\n');
                    }

                    Promise.all([
                        admin.from('agent_logs').insert({
                            project_id,
                            user_id: user.id,
                            conversation_id: convId,
                            role: 'assistant',
                            content: responseMsg,
                            tokens_used: finalResult.totalTokens,
                        }),
                        // admin.rpc('decrement_credits', { uid: user.id, amount: creditsToDeduct }),
                    ]).catch(() => {});

                    // Send final response
                    sendEvent('done', {
                        response: responseMsg,
                        meta: {
                            iterations: finalResult.iterations,
                            totalTokens: finalResult.totalTokens,
                            creditsUsed: creditsToDeduct,
                            toolsExecuted: finalResult.toolCalls,
                        },
                    });
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    const errStack = err instanceof Error ? err.stack : '';
                    console.error('Agent stream error:', errMsg, errStack);
                    sendEvent('error', {
                        error: errMsg,
                        stack: process.env.NODE_ENV === 'development' ? errStack : undefined,
                    });
                } finally {
                    unsubBus();
                    controller.close();
                }
            },
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
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
