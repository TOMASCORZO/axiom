/**
 * Realtime manifest — per-project declaration of the multiplayer surface.
 *
 * Lives at `realtime.axiom.json` in the project's file tree. The agent writes
 * it via the `configure_realtime` tool; the Realtime Studio panel renders a
 * widget per declared feature. Nothing in the Studio is hardcoded — if a
 * feature isn't in the manifest, it isn't shown.
 *
 * Topics declared here are *suffixes*. The SDK and Studio auto-prefix them
 * with `game:<project_id>:` at connection time (enforced by RLS).
 */

export const MANIFEST_PATH = 'realtime.axiom.json';
export const MANIFEST_VERSION = 1 as const;

export type RealtimeFieldType =
    | 'string'
    | 'number'
    | 'boolean'
    | 'vector2'
    | 'vector3'
    | 'json'
    | 'player_id'
    | 'timestamp';

export interface RealtimeField {
    name: string;
    type: RealtimeFieldType;
    required?: boolean;
    description?: string;
}

interface BaseFeature {
    id: string;
    label: string;
    description?: string;
    /** Channel topic suffix. Full topic becomes `game:<project_id>:<topic>`. */
    topic: string;
}

export interface ChatFeature extends BaseFeature {
    kind: 'chat';
    /** 'global' = one channel for the whole game; 'room' = one per room id. */
    scope: 'global' | 'room';
    /** Persist messages to `game_events` so the Studio can show history. */
    persist?: boolean;
    /** Max chars per message — hint for the UI, not enforced server-side. */
    maxLength?: number;
}

export interface RoomsFeature extends BaseFeature {
    kind: 'rooms';
    /** Free-form category (e.g. 'match', 'lobby', 'clan-war'). */
    roomKind: string;
    maxPlayers?: number;
    /** Extra fields a room carries in its meta (shown in Studio room cards). */
    metaFields?: RealtimeField[];
}

export interface PresenceFeature extends BaseFeature {
    kind: 'presence';
    /** Fields each player publishes via track(). Studio renders them. */
    fields: RealtimeField[];
}

export interface StateSyncFeature extends BaseFeature {
    kind: 'state';
    /** Fields in the shared state snapshot. */
    fields: RealtimeField[];
    /** How often clients should broadcast state (hint for agent-generated code). */
    tickHz?: number;
}

export interface EventsFeature extends BaseFeature {
    kind: 'events';
    events: Array<{
        name: string;
        description?: string;
        fields?: RealtimeField[];
        persist?: boolean;
    }>;
}

export interface CustomFeature extends BaseFeature {
    kind: 'custom';
    /** Anything the agent wants to declare that doesn't fit other kinds. */
    events?: Array<{ name: string; description?: string; fields?: RealtimeField[] }>;
    notes?: string;
}

export type RealtimeFeature =
    | ChatFeature
    | RoomsFeature
    | PresenceFeature
    | StateSyncFeature
    | EventsFeature
    | CustomFeature;

export interface RealtimeManifest {
    version: typeof MANIFEST_VERSION;
    features: RealtimeFeature[];
    /** Free-form notes the agent keeps for itself — not shown to the player. */
    notes?: string;
    updated_at?: string;
}

export const EMPTY_MANIFEST: RealtimeManifest = {
    version: MANIFEST_VERSION,
    features: [],
};

// ── Validation ────────────────────────────────────────────────────

const ID_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
const TOPIC_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const VALID_KINDS: RealtimeFeature['kind'][] = ['chat', 'rooms', 'presence', 'state', 'events', 'custom'];

export class ManifestValidationError extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = 'ManifestValidationError';
    }
}

function validateField(f: unknown, ctx: string): asserts f is RealtimeField {
    if (!f || typeof f !== 'object') throw new ManifestValidationError(`${ctx}: field must be object`);
    const field = f as Record<string, unknown>;
    if (typeof field.name !== 'string' || !field.name) throw new ManifestValidationError(`${ctx}: field.name required`);
    if (typeof field.type !== 'string') throw new ManifestValidationError(`${ctx}: field.type required`);
}

function validateFeature(feature: unknown, idx: number): asserts feature is RealtimeFeature {
    if (!feature || typeof feature !== 'object') {
        throw new ManifestValidationError(`features[${idx}]: must be object`);
    }
    const f = feature as Record<string, unknown>;
    if (typeof f.id !== 'string' || !ID_PATTERN.test(f.id)) {
        throw new ManifestValidationError(`features[${idx}]: id must match ${ID_PATTERN}`);
    }
    if (typeof f.label !== 'string' || !f.label) {
        throw new ManifestValidationError(`features[${idx}]: label required`);
    }
    if (typeof f.topic !== 'string' || !TOPIC_PATTERN.test(f.topic)) {
        throw new ManifestValidationError(`features[${idx}]: topic must match ${TOPIC_PATTERN}`);
    }
    if (!VALID_KINDS.includes(f.kind as RealtimeFeature['kind'])) {
        throw new ManifestValidationError(`features[${idx}]: kind must be one of ${VALID_KINDS.join(', ')}`);
    }

    const ctx = `features[${idx}] (${f.id})`;
    switch (f.kind) {
        case 'chat':
            if (f.scope !== 'global' && f.scope !== 'room') {
                throw new ManifestValidationError(`${ctx}: chat.scope must be 'global' or 'room'`);
            }
            break;
        case 'rooms':
            if (typeof f.roomKind !== 'string' || !f.roomKind) {
                throw new ManifestValidationError(`${ctx}: rooms.roomKind required`);
            }
            if (Array.isArray(f.metaFields)) f.metaFields.forEach((fl, i) => validateField(fl, `${ctx}.metaFields[${i}]`));
            break;
        case 'presence':
        case 'state':
            if (!Array.isArray(f.fields)) {
                throw new ManifestValidationError(`${ctx}: ${f.kind}.fields required`);
            }
            f.fields.forEach((fl, i) => validateField(fl, `${ctx}.fields[${i}]`));
            break;
        case 'events':
            if (!Array.isArray(f.events)) {
                throw new ManifestValidationError(`${ctx}: events.events[] required`);
            }
            for (const [i, ev] of f.events.entries()) {
                if (!ev || typeof ev !== 'object') throw new ManifestValidationError(`${ctx}.events[${i}]: must be object`);
                const e = ev as Record<string, unknown>;
                if (typeof e.name !== 'string' || !e.name) throw new ManifestValidationError(`${ctx}.events[${i}].name required`);
                if (Array.isArray(e.fields)) e.fields.forEach((fl, j) => validateField(fl, `${ctx}.events[${i}].fields[${j}]`));
            }
            break;
        case 'custom':
            // custom is deliberately loose — just requires id/label/topic.
            break;
    }
}

export function validateManifest(input: unknown): RealtimeManifest {
    if (!input || typeof input !== 'object') {
        throw new ManifestValidationError('manifest must be an object');
    }
    const m = input as Record<string, unknown>;
    if (m.version !== MANIFEST_VERSION) {
        throw new ManifestValidationError(`version must be ${MANIFEST_VERSION}`);
    }
    if (!Array.isArray(m.features)) {
        throw new ManifestValidationError('features[] required');
    }
    m.features.forEach(validateFeature);

    const ids = new Set<string>();
    const topics = new Set<string>();
    for (const f of m.features as RealtimeFeature[]) {
        if (ids.has(f.id)) throw new ManifestValidationError(`duplicate feature id: ${f.id}`);
        ids.add(f.id);
        if (topics.has(f.topic)) throw new ManifestValidationError(`duplicate topic: ${f.topic}`);
        topics.add(f.topic);
    }

    return {
        version: MANIFEST_VERSION,
        features: m.features as RealtimeFeature[],
        notes: typeof m.notes === 'string' ? m.notes : undefined,
        updated_at: typeof m.updated_at === 'string' ? m.updated_at : undefined,
    };
}

export function parseManifest(text: string): RealtimeManifest {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch (e) {
        throw new ManifestValidationError(`invalid JSON: ${e instanceof Error ? e.message : 'parse error'}`);
    }
    return validateManifest(json);
}

export function serializeManifest(manifest: RealtimeManifest): string {
    const normalized: RealtimeManifest = {
        ...manifest,
        version: MANIFEST_VERSION,
        updated_at: new Date().toISOString(),
    };
    return JSON.stringify(normalized, null, 2) + '\n';
}

// ── Topic helpers ─────────────────────────────────────────────────

export function fullTopicFor(gameId: string, suffix: string): string {
    return `game:${gameId}:${suffix}`;
}

export function stripGamePrefix(gameId: string, fullTopic: string): string | null {
    const prefix = `game:${gameId}:`;
    return fullTopic.startsWith(prefix) ? fullTopic.slice(prefix.length) : null;
}
