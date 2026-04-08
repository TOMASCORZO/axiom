import { NextRequest, NextResponse } from 'next/server';

// GET /api/assets/proxy-video?url=<encoded-video-url>
// Proxies a remote video to bypass CORS restrictions for client-side frame extraction
export async function GET(req: NextRequest) {
    const url = req.nextUrl.searchParams.get('url');
    if (!url) {
        return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
    }

    try {
        const res = await fetch(url);
        if (!res.ok) {
            return NextResponse.json({ error: `Upstream returned ${res.status}` }, { status: 502 });
        }

        const buffer = await res.arrayBuffer();
        const contentType = res.headers.get('content-type') || 'video/mp4';

        return new NextResponse(buffer, {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=3600',
            },
        });
    } catch {
        return NextResponse.json({ error: 'Failed to proxy video' }, { status: 500 });
    }
}
