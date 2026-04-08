import { NextRequest, NextResponse } from 'next/server';
import { removeBackground } from '@/lib/assets/generate';
import { fal } from '@fal-ai/client';

// POST /api/assets/remove-bg — Remove background from an image, returns transparent PNG
export async function POST(request: NextRequest) {
    try {
        const formData = await request.formData();
        const file = formData.get('file') as File | null;

        if (!file) {
            return NextResponse.json({ error: 'file is required' }, { status: 400 });
        }

        // Upload to fal.ai storage to get a public URL
        const fileUrl = await fal.storage.upload(file);

        // Run background removal
        const result = await removeBackground(fileUrl);

        if (!result.success || !result.imageUrl) {
            return NextResponse.json({ error: result.error || 'Background removal failed' }, { status: 500 });
        }

        // Download the transparent image and return it directly as PNG
        const imgRes = await fetch(result.imageUrl);
        const buffer = await imgRes.arrayBuffer();

        return new NextResponse(buffer, {
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
