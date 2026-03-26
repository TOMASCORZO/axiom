import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { executeTool } from '@/lib/agent/tools';

// Vercel Serverless Function config — 3D model generation can take up to 60s
export const maxDuration = 60;

// POST /api/assets/generate — Generate an asset via AI (standalone, outside agent loop)
export async function POST(request: NextRequest) {
    try {
        const supabase = await createServerSupabaseClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const { project_id, prompt, asset_type, style, target_path, options = {} } = body;

        if (!project_id || !prompt || !asset_type || !target_path) {
            return NextResponse.json(
                { error: 'project_id, prompt, asset_type, and target_path are required' },
                { status: 400 },
            );
        }

        // Check credits
        const creditCost: Record<string, number> = {
            sprite: 5,
            texture: 5,
            sprite_sheet: 8,
            model_3d: 10,
            animation: 8,
        };
        const cost = creditCost[asset_type] ?? 5;

        const { data: profile } = await supabase
            .from('profiles')
            .select('ai_credits_remaining')
            .eq('id', user.id)
            .single();

        if (!profile || profile.ai_credits_remaining < cost) {
            return NextResponse.json(
                { error: `Insufficient credits. Need ${cost}, have ${profile?.ai_credits_remaining ?? 0}` },
                { status: 429 },
            );
        }

        const ctx = { supabase, projectId: project_id, userId: user.id, createdFiles: [] as import('@/types/agent').ToolFileData[] };

        // Map asset_type to tool name and build input
        const toolMap: Record<string, string> = {
            sprite: 'generate_sprite', sprite_sheet: 'generate_sprite', ui_element: 'generate_sprite',
            texture: 'generate_texture', material: 'generate_texture',
            model_3d: 'generate_3d_model',
            animation: 'generate_animation',
        };
        const toolName = toolMap[asset_type];
        if (!toolName) {
            return NextResponse.json({ error: `Unknown asset type: ${asset_type}` }, { status: 400 });
        }

        const toolInput: Record<string, unknown> = { prompt, target_path, ...options };
        if (style) toolInput.style = style;

        const result = await executeTool(toolName, toolInput, ctx);

        // Deduct credits if generation was successful
        if (result.success) {
            await supabase.rpc('decrement_credits', { uid: user.id, amount: cost });
        }

        return NextResponse.json({
            success: result.success,
            asset_path: target_path,
            credits_used: result.success ? cost : 0,
            files_modified: result.filesModified,
            output: result.output,
            error: result.error,
            duration_ms: result.duration_ms,
        });
    } catch (err) {
        console.error('Asset generation error:', err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Internal server error' },
            { status: 500 },
        );
    }
}
