import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';

// GET /api/projects/[id]/conversations — List conversations for a project
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const supabase = await createServerSupabaseClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: projectId } = await params;
    const admin = getAdminClient();

    // Fetch all agent_logs for this project+user, ordered by time
    const { data: logs, error } = await admin
        .from('agent_logs')
        .select('conversation_id, role, content, created_at')
        .eq('project_id', projectId)
        .eq('user_id', user.id)
        .order('created_at', { ascending: true });

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Group by conversation_id
    const convMap = new Map<string, {
        id: string;
        title: string;
        messageCount: number;
        createdAt: string;
        lastMessageAt: string;
    }>();

    for (const log of logs ?? []) {
        const cid = log.conversation_id;
        if (!convMap.has(cid)) {
            convMap.set(cid, {
                id: cid,
                title: log.role === 'user' ? (log.content as string).slice(0, 80) : '',
                messageCount: 0,
                createdAt: log.created_at,
                lastMessageAt: log.created_at,
            });
        }
        const conv = convMap.get(cid)!;
        conv.messageCount++;
        conv.lastMessageAt = log.created_at;
        // Use first user message as title
        if (!conv.title && log.role === 'user') {
            conv.title = (log.content as string).slice(0, 80);
        }
    }

    // Sort by most recent first
    const conversations = Array.from(convMap.values())
        .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());

    return NextResponse.json({ conversations });
}
