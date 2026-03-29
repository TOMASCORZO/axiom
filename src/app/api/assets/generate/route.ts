import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';
import { executeTool } from '@/lib/agent/tools';

// Vercel Serverless Function config — 3D model generation can take up to 60s
export const maxDuration = 60;

// POST /api/assets/generate — Generate an asset via AI (standalone, outside agent loop)
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { project_id, prompt, asset_type, style, target_path, options = {} } = body;

        if (!project_id || !prompt || !asset_type || !target_path) {
            return NextResponse.json(
                { error: 'project_id, prompt, asset_type, and target_path are required' },
                { status: 400 },
            );
        }

        // Try cookie-based auth first, fall back to project ownership check
        let userId: string;
        const supabase = await createServerSupabaseClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        console.log('[generate] cookie auth:', user ? `user=${user.id}` : `no user, error=${authError?.message}`);

        if (user) {
            userId = user.id;
        } else {
            // Fallback: look up project owner via admin client
            const admin = getAdminClient();
            const { data: project, error: projectError } = await admin
                .from('projects')
                .select('owner_id')
                .eq('id', project_id)
                .single();
            console.log('[generate] fallback lookup:', { project_id, project, projectError: projectError?.message });
            if (!project?.owner_id) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
            userId = project.owner_id;
        }

        // Credits check disabled — will be configured later
        const cost = 0;

        const ctx = { supabase, projectId: project_id, userId, createdFiles: [] as import('@/types/agent').ToolFileData[] };

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

        // TODO: credit deduction — will be configured later

        // Extract storage_key from tool output (set by uploadBinaryAsset)
        const output = result.output as Record<string, unknown> | undefined;
        const storageKey = output?.storage_key as string | undefined;

        return NextResponse.json({
            success: result.success,
            asset_path: target_path,
            storage_key: storageKey ?? null,
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
