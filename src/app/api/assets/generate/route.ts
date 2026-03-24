import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import {
    executeGenerateSprite,
    executeGenerateTexture,
    executeGenerate3DModel,
    executeGenerateAnimation,
} from '@/lib/agent/tools';

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

        const ctx = { supabase, projectId: project_id, userId: user.id };

        // Dispatch to the correct generator
        let result;
        switch (asset_type) {
            case 'sprite':
            case 'sprite_sheet':
            case 'ui_element':
                result = await executeGenerateSprite(ctx, {
                    prompt,
                    style: style || 'stylized',
                    width: options.width || 128,
                    height: options.height || 128,
                    transparent_bg: options.transparent_bg ?? true,
                    target_path,
                });
                break;

            case 'texture':
            case 'material':
                result = await executeGenerateTexture(ctx, {
                    prompt,
                    style: style || 'stylized',
                    width: options.width || 512,
                    height: options.height || 512,
                    tileable: options.tileable || false,
                    target_path,
                });
                break;

            case 'model_3d':
                result = await executeGenerate3DModel(ctx, {
                    prompt,
                    topology: options.topology || 'standard',
                    textured: options.textured ?? true,
                    target_path,
                });
                break;

            case 'animation':
                result = await executeGenerateAnimation(ctx, {
                    prompt,
                    type: options.animation_type || 'sprite_frames',
                    frame_count: options.frame_count || 4,
                    fps: options.fps || 12,
                    loop: options.loop ?? true,
                    target_path,
                });
                break;

            default:
                return NextResponse.json({ error: `Unknown asset type: ${asset_type}` }, { status: 400 });
        }

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
