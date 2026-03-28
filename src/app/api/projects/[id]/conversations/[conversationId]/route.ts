import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';

// GET /api/projects/[id]/conversations/[conversationId] — Fetch conversation messages
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string; conversationId: string }> },
) {
    const supabase = await createServerSupabaseClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: projectId, conversationId } = await params;
    const admin = getAdminClient();

    const { data: messages, error } = await admin
        .from('agent_logs')
        .select('id, role, content, tool_name, tool_input, tool_output, tokens_used, duration_ms, created_at')
        .eq('project_id', projectId)
        .eq('user_id', user.id)
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ messages: messages ?? [] });
}

// DELETE /api/projects/[id]/conversations/[conversationId] — Delete a conversation
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string; conversationId: string }> },
) {
    const supabase = await createServerSupabaseClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: projectId, conversationId } = await params;
    const admin = getAdminClient();

    const { error } = await admin
        .from('agent_logs')
        .delete()
        .eq('project_id', projectId)
        .eq('user_id', user.id)
        .eq('conversation_id', conversationId);

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
}
