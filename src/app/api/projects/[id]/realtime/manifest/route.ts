/**
 * GET  /api/projects/[id]/realtime/manifest — read the project's realtime
 *      manifest (realtime.axiom.json). Returns `{ manifest: null }` if the
 *      file doesn't exist yet, so the Studio can show a proper empty state.
 *
 * POST /api/projects/[id]/realtime/manifest — write/replace the manifest.
 *      Body: the manifest JSON itself. Validated server-side before upsert.
 *
 * The manifest is the single source of truth for what the Realtime Studio
 * renders and what features the game has declared. The agent owns writes
 * via the `configure_realtime` tool; this endpoint is what the Studio reads.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/supabase/admin';
import { resolveProjectAuth } from '@/lib/game-db/auth';
import {
    MANIFEST_PATH,
    parseManifest,
    serializeManifest,
    validateManifest,
    ManifestValidationError,
} from '@/lib/realtime/manifest';

export const maxDuration = 5;

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    const auth = await resolveProjectAuth(id);
    if ('status' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const admin = getAdminClient();
    const { data: file } = await admin
        .from('project_files')
        .select('text_content, updated_at')
        .eq('project_id', id)
        .eq('path', MANIFEST_PATH)
        .maybeSingle();

    if (!file?.text_content) {
        return NextResponse.json({ manifest: null });
    }

    try {
        const manifest = parseManifest(file.text_content);
        return NextResponse.json({ manifest, updated_at: file.updated_at });
    } catch (e) {
        const message = e instanceof ManifestValidationError ? e.message : 'Failed to parse manifest';
        return NextResponse.json({ manifest: null, parse_error: message }, { status: 200 });
    }
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    const auth = await resolveProjectAuth(id);
    if ('status' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    let manifest;
    try {
        manifest = validateManifest(body);
    } catch (e) {
        const message = e instanceof ManifestValidationError ? e.message : 'Invalid manifest';
        return NextResponse.json({ error: message }, { status: 400 });
    }

    const text = serializeManifest(manifest);
    const admin = getAdminClient();
    const { error } = await admin.from('project_files').upsert({
        project_id: id,
        path: MANIFEST_PATH,
        content_type: 'text',
        text_content: text,
        size_bytes: new TextEncoder().encode(text).length,
        updated_at: new Date().toISOString(),
    }, { onConflict: 'project_id,path' });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ manifest, path: MANIFEST_PATH });
}
