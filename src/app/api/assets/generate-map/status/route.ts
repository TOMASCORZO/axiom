import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';

// Lightweight polling endpoint — just reads the map_jobs row.
export const maxDuration = 10;

export async function GET(request: NextRequest) {
    try {
        const jobId = request.nextUrl.searchParams.get('job_id');
        if (!jobId) {
            return NextResponse.json({ error: 'job_id required' }, { status: 400 });
        }

        const admin = getAdminClient();
        const { data: job, error } = await admin
            .from('map_jobs')
            .select('id, project_id, status, result, error, started_at, finished_at, created_at')
            .eq('id', jobId)
            .single();

        if (error || !job) {
            return NextResponse.json({ error: error?.message ?? 'Job not found' }, { status: 404 });
        }

        // Authorize: the job's project must be visible to the caller.
        const supabase = await createServerSupabaseClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            const { data: project } = await supabase
                .from('projects')
                .select('id')
                .eq('id', job.project_id)
                .maybeSingle();
            if (!project) {
                return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            }
        }
        // Unauthenticated callers can still poll by job_id — job_id is a UUID
        // and /start already validated project ownership before issuing it.

        return NextResponse.json({
            job_id: job.id,
            status: job.status,
            result: job.result,
            error: job.error,
            started_at: job.started_at,
            finished_at: job.finished_at,
            created_at: job.created_at,
        });
    } catch (err) {
        console.error('[generate-map/status] error:', err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Internal server error' },
            { status: 500 },
        );
    }
}
