import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';
import { executeTool } from '@/lib/agent/tools';
import type { ToolFileData } from '@/types/agent';
import { recordPixellabUsage } from '@/lib/assets/usage-tracking';
import { createLogger, newRequestId } from '@/lib/observability/logger';

// Worker route — does the actual map generation. Invoked fire-and-forget
// from /start, which means it gets its own fresh 300s serverless budget.
// Not called directly by the client.
export const maxDuration = 300;

interface JobRow {
    id: string;
    project_id: string;
    user_id: string;
    status: string;
    params: {
        prompt: string;
        target_path: string;
        options?: Record<string, unknown>;
    };
}

export async function POST(request: NextRequest) {
    const admin = getAdminClient();
    const requestId = newRequestId();
    const log = createLogger('generate-map/run', { requestId });
    let jobId: string | undefined;

    try {
        // Shared-secret check so the worker can't be triggered by arbitrary
        // external callers. /start sends the same header.
        const expected = process.env.MAP_WORKER_SECRET ?? '';
        if (expected) {
            const got = request.headers.get('x-worker-secret') ?? '';
            if (got !== expected) {
                return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            }
        }

        const body = await request.json();
        jobId = body?.job_id as string | undefined;
        if (!jobId) {
            return NextResponse.json({ error: 'job_id required' }, { status: 400 });
        }

        const { data: job, error: fetchErr } = await admin
            .from('map_jobs')
            .select('id, project_id, user_id, status, params')
            .eq('id', jobId)
            .single<JobRow>();

        if (fetchErr || !job) {
            return NextResponse.json({ error: fetchErr?.message ?? 'Job not found' }, { status: 404 });
        }
        if (job.status !== 'pending') {
            // Already picked up or completed — don't run again.
            return NextResponse.json({ success: true, already: job.status });
        }

        await admin.from('map_jobs')
            .update({ status: 'running', started_at: new Date().toISOString() })
            .eq('id', jobId);

        const supabase = await createServerSupabaseClient();
        const ctx = {
            supabase,
            projectId: job.project_id,
            userId: job.user_id,
            createdFiles: [] as ToolFileData[],
        };

        const toolInput: Record<string, unknown> = {
            prompt: job.params.prompt,
            target_path: job.params.target_path,
            ...(job.params.options ?? {}),
        };

        const t0 = Date.now();
        const result = await executeTool('generate_map', toolInput, ctx);
        const output = (result.output ?? {}) as Record<string, unknown>;
        const cost = typeof output.cost === 'number' ? output.cost : 0;

        await recordPixellabUsage({
            userId: job.user_id, projectId: job.project_id,
            kind: 'generate_map', surface: 'map_studio',
            costUsd: cost, success: result.success,
            durationMs: Date.now() - t0, requestId,
            metadata: {
                projection: (job.params.options as Record<string, unknown> | undefined)?.projection,
                grid_w: (job.params.options as Record<string, unknown> | undefined)?.grid_w,
                grid_h: (job.params.options as Record<string, unknown> | undefined)?.grid_h,
                error: result.success ? undefined : result.error,
            },
        });

        if (!result.success) {
            log.error('generate_map_failed', { jobId, userId: job.user_id, error: result.error });
            await admin.from('map_jobs')
                .update({
                    status: 'failed',
                    error: result.error ?? 'Map generation failed',
                    finished_at: new Date().toISOString(),
                })
                .eq('id', jobId);
            return NextResponse.json({ success: false, error: result.error });
        }
        await admin.from('map_jobs')
            .update({
                status: 'done',
                result: {
                    target_path: job.params.target_path,
                    storage_key: output?.storage_key ?? null,
                    asset_id: output?.asset_id ?? null,
                    width: output?.width ?? null,
                    height: output?.height ?? null,
                    map_metadata: output?.map_metadata ?? null,
                },
                finished_at: new Date().toISOString(),
            })
            .eq('id', jobId);

        return NextResponse.json({ success: true });
    } catch (err) {
        log.error('unhandled', { jobId, error: err instanceof Error ? err.message : String(err) });
        if (jobId) {
            await admin.from('map_jobs')
                .update({
                    status: 'failed',
                    error: err instanceof Error ? err.message : 'Internal server error',
                    finished_at: new Date().toISOString(),
                })
                .eq('id', jobId);
        }
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Internal server error' },
            { status: 500 },
        );
    }
}
