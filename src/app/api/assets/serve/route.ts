import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabase/admin';

// GET /api/assets/serve?key=projects/uid/pid/assets/foo.png
// Proxies files from Supabase Storage (works even if bucket is private)
export async function GET(req: NextRequest) {
    const key = req.nextUrl.searchParams.get('key');
    if (!key) {
        return NextResponse.json({ error: 'Missing key parameter' }, { status: 400 });
    }

    try {
        const admin = getAdminClient();
        const { data, error } = await admin.storage.from('assets').download(key);

        if (error || !data) {
            return NextResponse.json({ error: 'File not found' }, { status: 404 });
        }

        const buffer = await data.arrayBuffer();
        const ext = key.split('.').pop()?.toLowerCase() || 'png';
        const mimeMap: Record<string, string> = {
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
            webp: 'image/webp', svg: 'image/svg+xml', gif: 'image/gif',
            bmp: 'image/bmp', ico: 'image/x-icon',
        };

        return new NextResponse(buffer, {
            headers: {
                'Content-Type': mimeMap[ext] || 'application/octet-stream',
                'Cache-Control': 'public, max-age=3600, immutable',
            },
        });
    } catch {
        return NextResponse.json({ error: 'Failed to serve file' }, { status: 500 });
    }
}
