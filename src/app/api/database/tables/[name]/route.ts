import { NextRequest, NextResponse } from 'next/server';
import { describeGameTable } from '@/lib/game-db';
import { resolveProjectAuth } from '@/lib/game-db/auth';

export const maxDuration = 15;

// GET /api/database/tables/[name]?project_id=...
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ name: string }> },
) {
    const { name } = await params;
    const projectId = req.nextUrl.searchParams.get('project_id');
    if (!projectId) {
        return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }
    const auth = await resolveProjectAuth(projectId);
    if ('status' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    try {
        const schema = await describeGameTable(projectId, name);
        return NextResponse.json({ table_name: name, ...schema });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Internal error' },
            { status: 500 },
        );
    }
}
