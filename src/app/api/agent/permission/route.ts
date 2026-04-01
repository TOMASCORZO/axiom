import { NextRequest, NextResponse } from 'next/server';
import { bus } from '@/lib/bus';

export async function POST(request: NextRequest) {
    try {
        const { toolName, granted } = await request.json();
        
        if (typeof toolName !== 'string' || typeof granted !== 'boolean') {
            return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
        }

        // Emit response locally (works because Axiom agents run in dev/standalone mode locally)
        bus.emit('permission.response', { toolName, granted });
        
        return NextResponse.json({ success: true });
    } catch (err) {
        return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
}
