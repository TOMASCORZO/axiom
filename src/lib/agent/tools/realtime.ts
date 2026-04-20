/**
 * Realtime tool — the agent's single entry point for declaring a game's
 * multiplayer surface.
 *
 * The agent edits `realtime.axiom.json` (the manifest) through this tool;
 * the Realtime Studio panel renders whatever is declared there. If a feature
 * isn't in the manifest, the Studio won't show it — so adding a chat / lobby /
 * matchmaking flow means calling this tool, not just writing client code.
 *
 * Operations:
 *   - set_feature      Add a new feature or replace one by id (upsert).
 *   - remove_feature   Remove a feature by id.
 *   - replace_all      Rewrite the entire manifest (use sparingly).
 *
 * After editing the manifest the agent typically also writes game code that
 * uses `axiom.channel(feature.topic)` — the manifest is a declaration, not
 * runtime behaviour on its own.
 */

import { getAdminClient } from '@/lib/supabase/admin';
import { registerTool, type ToolContext, type ToolInput } from './registry';
import {
    MANIFEST_PATH,
    EMPTY_MANIFEST,
    parseManifest,
    serializeManifest,
    validateManifest,
    ManifestValidationError,
    type RealtimeManifest,
    type RealtimeFeature,
} from '@/lib/realtime/manifest';

async function loadManifest(projectId: string): Promise<RealtimeManifest> {
    const admin = getAdminClient();
    const { data } = await admin
        .from('project_files')
        .select('text_content')
        .eq('project_id', projectId)
        .eq('path', MANIFEST_PATH)
        .maybeSingle();
    if (!data?.text_content) return { ...EMPTY_MANIFEST };
    try {
        return parseManifest(data.text_content);
    } catch {
        return { ...EMPTY_MANIFEST };
    }
}

async function saveManifest(ctx: ToolContext, manifest: RealtimeManifest): Promise<void> {
    const text = serializeManifest(manifest);
    const sizeBytes = new TextEncoder().encode(text).length;
    ctx.createdFiles.push({
        path: MANIFEST_PATH,
        content: text,
        size_bytes: sizeBytes,
        content_type: 'text',
    });
    const admin = getAdminClient();
    const { error } = await admin.from('project_files').upsert({
        project_id: ctx.projectId,
        path: MANIFEST_PATH,
        content_type: 'text',
        text_content: text,
        size_bytes: sizeBytes,
        updated_at: new Date().toISOString(),
    }, { onConflict: 'project_id,path' });
    if (error) throw new Error(`Manifest write failed: ${error.message}`);
}

registerTool({
    name: 'configure_realtime',
    description:
        'Declare or edit the game\'s realtime/multiplayer features in realtime.axiom.json. ' +
        'Operations: set_feature (add or replace by id), remove_feature (by id), replace_all (new manifest). ' +
        'Use this whenever you add chat, rooms/lobbies, matchmaking, shared state, presence, or custom events. ' +
        'The Realtime Studio UI renders whatever this manifest declares. Call write_game_logic separately to wire the client code.',
    parameters: {
        type: 'object',
        properties: {
            operation: {
                type: 'string',
                enum: ['set_feature', 'remove_feature', 'replace_all'],
                description: 'What to do to the manifest.',
            },
            feature: {
                type: 'object',
                description:
                    'Feature to upsert (for set_feature). Required fields: id (kebab-case), label, topic (channel suffix, auto-prefixed with game:<id>:), kind. ' +
                    'Kind-specific fields: ' +
                    'chat → { scope: "global"|"room", persist?: boolean, maxLength?: number }; ' +
                    'rooms → { roomKind: string, maxPlayers?: number, metaFields?: Field[] }; ' +
                    'presence → { fields: Field[] }; ' +
                    'state → { fields: Field[], tickHz?: number }; ' +
                    'events → { events: Array<{ name, fields?: Field[], persist?: boolean, description? }> }; ' +
                    'custom → { events?: [...], notes?: string }. ' +
                    'Field = { name, type: "string"|"number"|"boolean"|"vector2"|"vector3"|"json"|"player_id"|"timestamp", required?, description? }.',
            },
            feature_id: {
                type: 'string',
                description: 'Feature id to remove (for remove_feature).',
            },
            manifest: {
                type: 'object',
                description: 'Full manifest object (for replace_all). Shape: { version: 1, features: [...], notes? }.',
            },
            notes: {
                type: 'string',
                description: 'Optional agent-side notes stored in the manifest (not shown to players).',
            },
        },
        required: ['operation'],
    },
    access: ['build'],
    isDestructive: false,
    execute: async (ctx: ToolContext, input: ToolInput) => {
        const start = Date.now();
        const operation = input.operation as 'set_feature' | 'remove_feature' | 'replace_all';

        try {
            let next: RealtimeManifest;

            if (operation === 'replace_all') {
                if (!input.manifest || typeof input.manifest !== 'object') {
                    throw new Error('replace_all requires `manifest` object');
                }
                next = validateManifest(input.manifest);
            } else {
                const current = await loadManifest(ctx.projectId);

                if (operation === 'set_feature') {
                    if (!input.feature || typeof input.feature !== 'object') {
                        throw new Error('set_feature requires `feature` object');
                    }
                    const feature = input.feature as RealtimeFeature;
                    const others = current.features.filter(f => f.id !== feature.id);
                    // Validate the full manifest so feature-kind-specific fields are checked.
                    next = validateManifest({
                        ...current,
                        features: [...others, feature],
                    });
                } else if (operation === 'remove_feature') {
                    const id = input.feature_id;
                    if (typeof id !== 'string' || !id) {
                        throw new Error('remove_feature requires `feature_id`');
                    }
                    next = {
                        ...current,
                        features: current.features.filter(f => f.id !== id),
                    };
                } else {
                    throw new Error(`Unknown operation: ${operation}`);
                }
            }

            if (typeof input.notes === 'string') next.notes = input.notes;

            await saveManifest(ctx, next);

            return {
                callId: '',
                success: true,
                output: {
                    message: describeOperation(operation, input, next),
                    path: MANIFEST_PATH,
                    feature_count: next.features.length,
                    features: next.features.map(f => ({ id: f.id, kind: f.kind, topic: f.topic, label: f.label })),
                },
                filesModified: [MANIFEST_PATH],
                duration_ms: Date.now() - start,
            };
        } catch (e) {
            const message = e instanceof ManifestValidationError
                ? `Invalid manifest: ${e.message}`
                : e instanceof Error ? e.message : 'Unknown error';
            return {
                callId: '',
                success: false,
                error: message,
                output: { message },
                filesModified: [],
                duration_ms: Date.now() - start,
            };
        }
    },
});

function describeOperation(op: string, input: ToolInput, next: RealtimeManifest): string {
    switch (op) {
        case 'set_feature': {
            const f = input.feature as RealtimeFeature;
            return `Realtime: ${f.kind} feature "${f.id}" set (topic=${f.topic})`;
        }
        case 'remove_feature':
            return `Realtime: feature "${input.feature_id}" removed`;
        case 'replace_all':
            return `Realtime: manifest replaced (${next.features.length} features)`;
    }
    return 'Realtime: manifest updated';
}
