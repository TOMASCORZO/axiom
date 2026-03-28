import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 30;

/**
 * Resolve an actual downloadable image URL from a source page.
 * Kenney and OpenGameArt don't have predictable CDN URLs,
 * so we fetch the page HTML and extract og:image or preview images.
 */
async function resolveImageUrl(pageUrl: string): Promise<string | null> {
    try {
        const res = await fetch(pageUrl, {
            headers: { 'Accept': 'text/html', 'User-Agent': 'Axiom-Engine/1.0' },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        const html = await res.text();

        // Try og:image first (handles both single and double quotes)
        const ogMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/);
        if (ogMatch) return ogMatch[1];

        // Try twitter:image
        const twMatch = html.match(/<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/);
        if (twMatch) return twMatch[1];

        // Try img with preview/thumbnail/cover/banner in src (single or double quotes)
        const imgMatch = html.match(/<img[^>]+src=["'](https?:\/\/[^"']+(?:preview|thumbnail|cover|banner)[^"']*\.(?:png|jpg|webp))["']/i);
        if (imgMatch) return imgMatch[1];

        // Fallback: any img with a common image extension on the same domain
        const genericMatch = html.match(/<img[^>]+src=["'](https?:\/\/[^"']+\.(?:png|jpg|webp))["']/i);
        if (genericMatch) return genericMatch[1];

        return null;
    } catch {
        return null;
    }
}

// POST /api/assets/import — Download a free asset and add it to the project
export async function POST(request: NextRequest) {
    try {
        const supabase = await createServerSupabaseClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const { project_id, download_url, preview_url, page_url, target_path, title, source } = body;

        if (!project_id || !target_path) {
            return NextResponse.json({ error: 'project_id and target_path are required' }, { status: 400 });
        }

        // Resolve the actual image URL — try direct URLs first, then scrape page
        let imageUrl = download_url || preview_url;

        if (!imageUrl && page_url) {
            imageUrl = await resolveImageUrl(page_url);
        }

        if (!imageUrl) {
            return NextResponse.json(
                { error: `Could not find a downloadable image for "${title}" on ${source}. Try visiting the source page directly.` },
                { status: 404 },
            );
        }

        // Download the asset
        const assetRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
        if (!assetRes.ok) {
            // If direct download fails and we have a page URL, try scraping
            if (page_url && imageUrl !== page_url) {
                const scraped = await resolveImageUrl(page_url);
                if (scraped) {
                    const retry = await fetch(scraped, { signal: AbortSignal.timeout(15000) });
                    if (retry.ok) {
                        return await saveAsset(retry, project_id, target_path, title, source, user.id);
                    }
                }
            }
            return NextResponse.json(
                { error: `Download failed (${assetRes.status}). Visit ${source} to download manually.` },
                { status: 502 },
            );
        }

        return await saveAsset(assetRes, project_id, target_path, title, source, user.id);
    } catch (err) {
        console.error('Asset import error:', err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Internal server error' },
            { status: 500 },
        );
    }
}

async function saveAsset(
    assetRes: Response,
    projectId: string,
    targetPath: string,
    title: string,
    source: string,
    userId: string,
) {
    const buffer = await assetRes.arrayBuffer();
    if (buffer.byteLength === 0) {
        return NextResponse.json({ error: 'Downloaded file is empty' }, { status: 400 });
    }
    if (buffer.byteLength > 10 * 1024 * 1024) {
        return NextResponse.json({ error: 'File too large (>10MB)' }, { status: 400 });
    }

    const mimeType = assetRes.headers.get('content-type') || 'image/png';
    const admin = getAdminClient();
    const storageKey = `projects/${userId}/${projectId}/${targetPath}`;

    const { error: uploadError } = await admin.storage
        .from('assets')
        .upload(storageKey, buffer, { contentType: mimeType, upsert: true });

    if (uploadError) {
        return NextResponse.json(
            { error: `Storage upload failed: ${uploadError.message}` },
            { status: 500 },
        );
    }

    // Get a public URL for the thumbnail
    const { data: urlData } = admin.storage.from('assets').getPublicUrl(storageKey);

    // Register in project_files
    await admin.from('project_files').upsert({
        project_id: projectId,
        path: targetPath,
        content_type: 'binary',
        size_bytes: buffer.byteLength,
        storage_key: storageKey,
        updated_at: new Date().toISOString(),
    }, { onConflict: 'project_id,path' });

    return NextResponse.json({
        success: true,
        path: targetPath,
        size_bytes: buffer.byteLength,
        storage_key: storageKey,
        public_url: urlData?.publicUrl || null,
        source: source || 'unknown',
        title: title || targetPath,
    });
}
