import { NextRequest, NextResponse } from 'next/server';
import { searchFreeAssets } from '@/lib/assets/search';

export async function GET(req: NextRequest) {
    const { searchParams } = req.nextUrl;
    const query = searchParams.get('q');
    const assetType = searchParams.get('type') || 'sprite';

    if (!query || query.trim().length === 0) {
        return NextResponse.json({ results: [] });
    }

    const results = await searchFreeAssets(query.trim(), assetType);
    return NextResponse.json({ results });
}
