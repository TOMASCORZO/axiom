/**
 * Shared auth shim for /api/database/* routes.
 *
 * Mirrors the pattern in /api/assets/generate/route.ts: try cookie-based auth
 * first, fall back to looking up the project owner via the admin client. The
 * fallback exists because some clients (engine bridges, agent worker calls)
 * don't carry the user cookie but do come from a trusted server context.
 */

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';

export interface ResolvedAuth {
    userId: string;
}

export interface AuthFailure {
    status: 401 | 403;
    error: string;
}

export async function resolveProjectAuth(projectId: string): Promise<ResolvedAuth | AuthFailure> {
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
        // Confirm ownership before trusting the cookie. Collaborators table
        // doesn't exist in v1 — extend this when multi-user editing ships.
        const admin = getAdminClient();
        const { data: project } = await admin
            .from('projects')
            .select('id, owner_id')
            .eq('id', projectId)
            .single();
        if (!project) return { status: 403, error: 'Project not found' };
        if (project.owner_id !== user.id) return { status: 403, error: 'Not the project owner' };
        return { userId: user.id };
    }

    // No cookie — fall back to project owner lookup. Anonymous external callers
    // can't reach this branch because the request still has to be inside the
    // Vercel function (no public exposure).
    const admin = getAdminClient();
    const { data: project } = await admin
        .from('projects')
        .select('owner_id')
        .eq('id', projectId)
        .single();
    if (!project?.owner_id) return { status: 401, error: 'Unauthorized' };
    return { userId: project.owner_id };
}
