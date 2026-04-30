import { NextRequest, NextResponse, after } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';
import { enforcePixellabBudget } from '@/lib/assets/usage-tracking';
import { createLogger, newRequestId } from '@/lib/observability/logger';

// /start is a thin enqueue step — it must return fast so the client can
// begin polling. The heavy work happens in /run, which gets its own fresh
// serverless invocation budget (300s) via an internal fire-and-forget fetch.
export const maxDuration = 30;

export async function POST(request: NextRequest) {
    const requestId = newRequestId();
    const log = createLogger('generate-map/start', { requestId });
    try {
        const body = await request.json();
        const { project_id, prompt, target_path, options } = body ?? {};

        if (!project_id || !prompt || !target_path) {
            return NextResponse.json(
                { error: 'project_id, prompt, and target_path are required' },
                { status: 400 },
            );
        }

        let userId: string;
        const supabase = await createServerSupabaseClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            userId = user.id;
        } else {
            const admin = getAdminClient();
            const { data: project } = await admin
                .from('projects')
                .select('owner_id')
                .eq('id', project_id)
                .single();
            if (!project?.owner_id) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
            userId = project.owner_id;
        }

        // Fail fast on rate-limited users so we don't enqueue a job that
        // would just sit pending. The worker checks again — this is a UX
        // optimization, not a security boundary.
        const gate = await enforcePixellabBudget(userId);
        if (!gate.ok) {
            log.warn('rate_limited', { userId, reason: gate.reason, callCount: gate.callCount, totalCostUsd: gate.totalCostUsd });
            return NextResponse.json(
                { success: false, error: gate.reason, code: 'rate_limited', usage: gate },
                { status: 429 },
            );
        }

        const admin = getAdminClient();
        const { data: job, error: insertErr } = await admin
            .from('map_jobs')
            .insert({
                project_id,
                user_id: userId,
                status: 'pending',
                params: { prompt, target_path, options: options ?? {} },
            })
            .select('id')
            .single();

        if (insertErr || !job) {
            return NextResponse.json(
                { error: insertErr?.message ?? 'Failed to enqueue job' },
                { status: 500 },
            );
        }

        // Kick off the worker on a fresh invocation. We don't await the fetch
        // response — /run does the work with its own 300s budget and writes
        // the result back to map_jobs. `after()` guarantees the fetch is
        // actually dispatched before this function shuts down.
        const origin = new URL(request.url).origin;
        const workerSecret = process.env.MAP_WORKER_SECRET ?? '';
        after(async () => {
            try {
                await fetch(`${origin}/api/assets/generate-map/run`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-worker-secret': workerSecret,
                    },
                    body: JSON.stringify({ job_id: job.id }),
                });
            } catch (err) {
                log.error('worker_dispatch_failed', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
                await admin.from('map_jobs')
                    .update({
                        status: 'failed',
                        error: err instanceof Error ? err.message : 'Worker dispatch failed',
                        finished_at: new Date().toISOString(),
                    })
                    .eq('id', job.id);
            }
        });

        return NextResponse.json({ success: true, job_id: job.id });
    } catch (err) {
        log.error('unhandled', { error: err instanceof Error ? err.message : String(err) });
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Internal server error' },
            { status: 500 },
        );
    }
}
