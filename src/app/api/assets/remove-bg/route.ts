import { NextRequest, NextResponse } from 'next/server';
import { removeBackground } from '@/lib/assets/generate';

// POST /api/assets/remove-bg — Remove background from an image, returns transparent PNG
export async function POST(request: NextRequest) {
    try {
        const formData = await request.formData();
        const file = formData.get('file') as File | null;

        if (!file) {
            return NextResponse.json({ error: 'file is required' }, { status: 400 });
        }

        const buffer = await file.arrayBuffer();
        const result = await removeBackground(buffer);

        if (!result.success || !result.buffer) {
            return NextResponse.json({ error: result.error || 'Background removal failed' }, { status: 500 });
        }

        return new NextResponse(result.buffer, {
            headers: {
                'Content-Type': 'image/png',
                'Cache-Control': 'no-store',
            },
        });
    } catch (err) {
        console.error('Remove-bg error:', err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Internal server error' },
            { status: 500 },
        );
    }
}
