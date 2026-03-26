import { NextResponse } from 'next/server';
import { mcpManager } from '@/lib/mcp';
import { ptyManager } from '@/lib/pty';
import { lspManager } from '@/lib/lsp';
import { bus } from '@/lib/bus';
import { getToolScanPaths } from '@/lib/tools/dynamic';

/**
 * GET /api/agent/status — Returns the status of all Axiom subsystems.
 * Used by the UI to show live subsystem health.
 */
export async function GET() {
    try {
        const status = {
            eventBus: {
                active: true,
                listenerCount: bus.listenerCount(),
            },
            mcp: {
                servers: mcpManager.status(),
            },
            pty: {
                sessions: ptyManager.list(),
            },
            lsp: {
                servers: lspManager.status(),
            },
            dynamicTools: {
                scanPaths: getToolScanPaths(),
            },
        };

        return NextResponse.json(status);
    } catch (err) {
        console.error('Status endpoint error:', err);
        return NextResponse.json({ error: 'Failed to get status' }, { status: 500 });
    }
}
