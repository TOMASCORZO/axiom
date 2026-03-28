import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';
import JSZip from 'jszip';

export const maxDuration = 60;

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|webp|svg)$/i;
const MAX_PACK_SIZE = 50 * 1024 * 1024; // 50 MB for ZIP packs
const MAX_SINGLE_FILE = 10 * 1024 * 1024; // 10 MB for single files

/**
 * Scrape a page for a ZIP download link (Kenney, OpenGameArt, etc.)
 */
async function resolveDownloadUrl(pageUrl: string): Promise<{ zip: string | null; image: string | null }> {
    try {
        const res = await fetch(pageUrl, {
            headers: { 'Accept': 'text/html', 'User-Agent': 'Axiom-Engine/1.0' },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return { zip: null, image: null };
        const html = await res.text();

        // Look for ZIP download link
        const zipMatch = html.match(/href=["'](https?:\/\/[^"']+\.zip)["']/i);
        const zip = zipMatch ? zipMatch[1] : null;

        // Look for preview image (single/double quotes)
        let image: string | null = null;
        const ogMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/);
        if (ogMatch) {
            image = ogMatch[1];
        } else {
            const imgMatch = html.match(/<img[^>]+src=["'](https?:\/\/[^"']+(?:preview|thumbnail|cover|banner)[^"']*\.(?:png|jpg|webp))["']/i);
            if (imgMatch) image = imgMatch[1];
        }

        return { zip, image };
    } catch {
        return { zip: null, image: null };
    }
}

// POST /api/assets/import — Download a free asset pack and add files to the project
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

        const admin = getAdminClient();
        // target_path is like "assets/sprites/toon-characters-1.png" — use its directory as base
        const baseDir = target_path.replace(/\/[^/]+$/, '');

        // Try to find a ZIP download link from the page
        if (page_url) {
            const { zip, image } = await resolveDownloadUrl(page_url);

            if (zip) {
                return await importZipPack(zip, project_id, baseDir, title, source, user.id, image, admin);
            }

            // No ZIP found — fall back to single image
            if (image) {
                return await saveSingleAsset(image, project_id, target_path, title, source, user.id, admin);
            }
        }

        // Try direct URLs
        const directUrl = download_url || preview_url;
        if (directUrl) {
            return await saveSingleAsset(directUrl, project_id, target_path, title, source, user.id, admin);
        }

        return NextResponse.json(
            { error: `Could not find downloadable assets for "${title}" on ${source}. Try visiting the source page directly.` },
            { status: 404 },
        );
    } catch (err) {
        console.error('Asset import error:', err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Internal server error' },
            { status: 500 },
        );
    }
}

/**
 * Download a ZIP pack, extract image files, and upload each to storage.
 */
async function importZipPack(
    zipUrl: string,
    projectId: string,
    baseDir: string,
    packTitle: string,
    source: string,
    userId: string,
    previewUrl: string | null,
    admin: ReturnType<typeof getAdminClient>,
) {
    const zipRes = await fetch(zipUrl, { signal: AbortSignal.timeout(25000) });
    if (!zipRes.ok) {
        return NextResponse.json(
            { error: `ZIP download failed (${zipRes.status}). Visit ${source} to download manually.` },
            { status: 502 },
        );
    }

    const zipBuffer = await zipRes.arrayBuffer();
    if (zipBuffer.byteLength > MAX_PACK_SIZE) {
        return NextResponse.json({ error: 'Pack too large (>50MB)' }, { status: 400 });
    }

    const zip = await JSZip.loadAsync(zipBuffer);
    const files: Array<{ path: string; public_url: string; size_bytes: number }> = [];

    // Extract all image files from the ZIP
    const entries = Object.entries(zip.files).filter(
        ([name, entry]) => !entry.dir && IMAGE_EXTENSIONS.test(name),
    );

    if (entries.length === 0) {
        return NextResponse.json({ error: 'No image files found in the pack' }, { status: 400 });
    }

    // Upload in parallel batches of 10
    const batchSize = 10;
    for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);
        const results = await Promise.allSettled(
            batch.map(async ([name, entry]) => {
                const data = await entry.async('arraybuffer');
                if (!data || data.byteLength === 0) return null;

                // Flatten path: "Toon Characters/PNG/character_01.png" → "character_01.png"
                const fileName = name.split('/').pop()!;
                const assetPath = `${baseDir}/${fileName}`;
                const storageKey = `projects/${userId}/${projectId}/${assetPath}`;
                const ext = fileName.split('.').pop()?.toLowerCase() || 'png';
                const mimeMap: Record<string, string> = {
                    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                    webp: 'image/webp', svg: 'image/svg+xml',
                };

                const { error } = await admin.storage
                    .from('assets')
                    .upload(storageKey, data, { contentType: mimeMap[ext] || 'image/png', upsert: true });

                if (error) return null;

                const { data: urlData } = admin.storage.from('assets').getPublicUrl(storageKey);

                await admin.from('project_files').upsert({
                    project_id: projectId,
                    path: assetPath,
                    content_type: 'binary',
                    size_bytes: data.byteLength,
                    storage_key: storageKey,
                    updated_at: new Date().toISOString(),
                }, { onConflict: 'project_id,path' });

                return {
                    path: assetPath,
                    public_url: urlData?.publicUrl || null,
                    size_bytes: data.byteLength,
                };
            }),
        );

        for (const r of results) {
            if (r.status === 'fulfilled' && r.value) {
                files.push(r.value as { path: string; public_url: string; size_bytes: number });
            }
        }
    }

    return NextResponse.json({
        success: true,
        pack: true,
        title: packTitle,
        source: source || 'unknown',
        preview_url: previewUrl,
        files_imported: files.length,
        total_in_pack: entries.length,
        files,
    });
}

/**
 * Download and save a single image file.
 */
async function saveSingleAsset(
    imageUrl: string,
    projectId: string,
    targetPath: string,
    title: string,
    source: string,
    userId: string,
    admin: ReturnType<typeof getAdminClient>,
) {
    const assetRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
    if (!assetRes.ok) {
        return NextResponse.json(
            { error: `Download failed (${assetRes.status}). Visit ${source} to download manually.` },
            { status: 502 },
        );
    }

    const buffer = await assetRes.arrayBuffer();
    if (buffer.byteLength === 0) {
        return NextResponse.json({ error: 'Downloaded file is empty' }, { status: 400 });
    }
    if (buffer.byteLength > MAX_SINGLE_FILE) {
        return NextResponse.json({ error: 'File too large (>10MB)' }, { status: 400 });
    }

    const mimeType = assetRes.headers.get('content-type') || 'image/png';
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

    const { data: urlData } = admin.storage.from('assets').getPublicUrl(storageKey);

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
        pack: false,
        path: targetPath,
        size_bytes: buffer.byteLength,
        storage_key: storageKey,
        public_url: urlData?.publicUrl || null,
        source: source || 'unknown',
        title: title || targetPath,
    });
}
