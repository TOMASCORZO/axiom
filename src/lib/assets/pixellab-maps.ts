/**
 * PixelLab "Create map" endpoints — distinct from the pixflux sprite path.
 *
 *   - /create-tileset           Wang tileset (16 tiles, corner-labeled) for top-down maps
 *   - /create-tiles-pro         Multi-variant tile set (iso / hex / square), style-locked
 *   - /create-isometric-tile    Single iso tile
 *   - /map-objects              Single object, optional background_image + inpainting
 *
 * All four are async: POST returns 202 + a resource id, then we poll the
 * resource-specific GET path until it returns 200 (423 means still processing).
 */

const PIXELLAB_BASE = 'https://api.pixellab.ai/v2';
const pixelLabToken = process.env.PIXELLAB_API_TOKEN;

// ── Types ────────────────────────────────────────────────────────────

export type TerrainCorner = 'lower' | 'upper' | 'transition';

export interface WangTileResp {
    id: string;
    name?: string;
    description?: string;
    image: { type: 'base64'; base64: string; format?: string };
    corners: { NW: TerrainCorner; NE: TerrainCorner; SW: TerrainCorner; SE: TerrainCorner };
    connections?: string[];
}

export interface CreateTilesetResp {
    tileset: {
        total_tiles: number;
        tile_size: { width: number; height: number };
        terrain_types: string[];
        tiles: WangTileResp[];
    };
    metadata?: Record<string, unknown>;
    usage?: { type: string; usd?: number };
}

export interface TilesProTile {
    id?: string;
    image?: { type: 'base64'; base64: string };
    base64?: string; // some shapes expose it flat
    storage_url?: string;
}

export interface CreateTilesProResp {
    tiles?: TilesProTile[];
    storage_urls?: Record<string, string>;
    images?: Array<{ base64: string }>;
    usage?: { type: string; usd?: number };
}

export interface CreateIsoTileResp {
    image?: { type: 'base64'; base64: string };
    base64?: string;
    usage?: { type: string; usd?: number };
}

export interface CreateMapObjectResp {
    image?: { type: 'base64'; base64: string };
    images?: Array<{ base64: string }>;
    base64?: string;
    usage?: { type: string; usd?: number };
}

// ── HTTP helpers ─────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
    if (!pixelLabToken) {
        throw new Error('PIXELLAB_API_TOKEN not set — get your key at https://pixellab.ai/account');
    }
    return {
        Authorization: `Bearer ${pixelLabToken}`,
        'Content-Type': 'application/json',
    };
}

async function extractError(res: Response, endpoint: string): Promise<string> {
    const raw = await res.text().catch(() => '');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    const body = parsed as { error?: string; detail?: unknown; message?: string };
    if (typeof body === 'object' && body !== null) {
        return body.error || body.message ||
            (typeof body.detail === 'string' ? body.detail :
                body.detail !== undefined ? JSON.stringify(body.detail).slice(0, 400) :
                    `PixelLab ${endpoint} HTTP ${res.status}`);
    }
    return raw.slice(0, 400) || `PixelLab ${endpoint} HTTP ${res.status}`;
}

/**
 * Submit an async job and poll the resource-specific GET path until it
 * returns 200 (or 423 signals still processing). The create endpoints for
 * tilesets / tiles-pro / iso-tiles / map-objects all follow this shape.
 */
async function submitAndPoll<T>(
    createEndpoint: string,
    body: unknown,
    idField: string,
    resourcePath: (id: string) => string,
    options: { submitTimeoutMs?: number; pollIntervalMs?: number; maxAttempts?: number } = {},
): Promise<T> {
    const submitTimeoutMs = options.submitTimeoutMs ?? 60_000;
    const pollInterval = options.pollIntervalMs ?? 2000;
    const maxAttempts = options.maxAttempts ?? 135; // ~4.5 minutes

    const submitRes = await fetch(`${PIXELLAB_BASE}${createEndpoint}`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(submitTimeoutMs),
    });

    // Fast path: some endpoints may return a completed 200 directly
    if (submitRes.status === 200) {
        return submitRes.json() as Promise<T>;
    }

    if (submitRes.status !== 202) {
        const msg = await extractError(submitRes, createEndpoint);
        console.error(`[pixellab-maps] ${createEndpoint} ${submitRes.status} → ${msg}`);
        throw new Error(`PixelLab ${createEndpoint} ${submitRes.status}: ${msg}`);
    }

    const jobEnvelope = await submitRes.json().catch(() => ({} as Record<string, unknown>));
    // Id may live at top level, under .data, or under .result depending on endpoint.
    const pickId = (obj: Record<string, unknown>): string | undefined => {
        const direct = obj[idField];
        if (typeof direct === 'string') return direct;
        const nested = obj.data as Record<string, unknown> | undefined;
        if (nested && typeof nested[idField] === 'string') return nested[idField] as string;
        return undefined;
    };
    const resourceId = pickId(jobEnvelope as Record<string, unknown>);
    if (!resourceId) {
        console.error('[pixellab-maps] 202 but no id:', JSON.stringify(jobEnvelope).slice(0, 500));
        throw new Error(`PixelLab ${createEndpoint} returned 202 without ${idField}`);
    }

    const pollPath = resourcePath(resourceId);
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, pollInterval));
        const res = await fetch(`${PIXELLAB_BASE}${pollPath}`, {
            headers: { Authorization: `Bearer ${pixelLabToken}` },
            signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 423) continue; // still processing
        if (res.status === 200) return res.json() as Promise<T>;
        const msg = await extractError(res, pollPath);
        throw new Error(`PixelLab ${pollPath} ${res.status}: ${msg}`);
    }
    throw new Error(`PixelLab ${createEndpoint} polling timed out after ${maxAttempts * pollInterval / 1000}s`);
}

// ── Base64 decode helper ──────────────────────────────────────────────

/** Decode a base64 field tolerating an optional `data:image/…;base64,` prefix. */
export function decodeB64(b64: string | undefined | null): Buffer | null {
    if (!b64) return null;
    const commaIdx = b64.indexOf(',');
    const payload = b64.startsWith('data:') && commaIdx >= 0 ? b64.slice(commaIdx + 1) : b64;
    try {
        return Buffer.from(payload, 'base64');
    } catch {
        return null;
    }
}

// ── /create-tileset (Wang) ────────────────────────────────────────────

export interface CreateTilesetOptions {
    lowerDescription: string;
    upperDescription: string;
    transitionDescription?: string;
    tileSize?: 16 | 32;
    view?: 'low top-down' | 'high top-down';
    transitionSize?: 0 | 0.25 | 0.5 | 0.75 | 1.0;
    seed?: number;
    outline?: string;
    shading?: string;
    detail?: string;
}

export async function createTileset(opts: CreateTilesetOptions): Promise<CreateTilesetResp> {
    const ts = opts.tileSize ?? 32;
    const body: Record<string, unknown> = {
        lower_description: opts.lowerDescription,
        upper_description: opts.upperDescription,
        tile_size: { width: ts, height: ts },
    };
    if (opts.transitionDescription) body.transition_description = opts.transitionDescription;
    if (opts.view) body.view = opts.view;
    if (opts.transitionSize !== undefined) body.transition_size = opts.transitionSize;
    if (opts.seed !== undefined) body.seed = opts.seed;
    if (opts.outline) body.outline = opts.outline;
    if (opts.shading) body.shading = opts.shading;
    if (opts.detail) body.detail = opts.detail;

    return submitAndPoll<CreateTilesetResp>(
        '/create-tileset',
        body,
        'tileset_id',
        (id) => `/tilesets/${id}`,
    );
}

// ── /create-tiles-pro (iso / hex / square variants) ───────────────────

export type TilesProShape = 'isometric' | 'hex' | 'hex_pointy' | 'octagon' | 'square_topdown';

export interface CreateTilesProOptions {
    description: string;
    tileType: TilesProShape;
    tileSize?: number;
    nTiles?: number;
    tileView?: 'top-down' | 'high top-down' | 'low top-down' | 'side';
    seed?: number;
}

export async function createTilesPro(opts: CreateTilesProOptions): Promise<CreateTilesProResp> {
    const body: Record<string, unknown> = {
        description: opts.description,
        tile_type: opts.tileType,
    };
    if (opts.tileSize !== undefined) body.tile_size = opts.tileSize;
    if (opts.nTiles !== undefined) body.n_tiles = opts.nTiles;
    if (opts.tileView) body.tile_view = opts.tileView;
    if (opts.seed !== undefined) body.seed = opts.seed;

    return submitAndPoll<CreateTilesProResp>(
        '/create-tiles-pro',
        body,
        'tile_id',
        (id) => `/tiles-pro/${id}`,
    );
}

/**
 * Normalize the tiles-pro response into a list of PNG buffers. The API
 * has several shapes across versions — try each in order.
 */
export function extractTilesProBuffers(resp: CreateTilesProResp): Buffer[] {
    const out: Buffer[] = [];
    if (resp.tiles && resp.tiles.length) {
        for (const t of resp.tiles) {
            const b = decodeB64(t.image?.base64 ?? t.base64 ?? null);
            if (b) out.push(b);
        }
        if (out.length > 0) return out;
    }
    if (resp.images && resp.images.length) {
        for (const im of resp.images) {
            const b = decodeB64(im.base64);
            if (b) out.push(b);
        }
        if (out.length > 0) return out;
    }
    // storage_urls path — these are remote URLs; we can't synchronously decode
    // them here but we return an empty array and let the caller fetch.
    return out;
}

/** Remote URLs variant (only when tiles-pro returns storage_urls). */
export function extractTilesProUrls(resp: CreateTilesProResp): string[] {
    const urls: string[] = [];
    if (resp.storage_urls) {
        for (const key of Object.keys(resp.storage_urls).sort()) {
            urls.push(resp.storage_urls[key]);
        }
    }
    if (resp.tiles && resp.tiles.length && urls.length === 0) {
        for (const t of resp.tiles) if (t.storage_url) urls.push(t.storage_url);
    }
    return urls;
}

// ── /create-isometric-tile (single) ───────────────────────────────────

export interface CreateIsoTileOptions {
    description: string;
    width?: number;
    height?: number;
    isoShape?: 'thin tile' | 'thick tile' | 'block';
    isoTileSize?: 16 | 32;
    seed?: number;
    textGuidanceScale?: number;
}

export async function createIsometricTile(opts: CreateIsoTileOptions): Promise<CreateIsoTileResp> {
    const w = Math.max(16, Math.min(opts.width ?? 32, 64));
    const h = Math.max(16, Math.min(opts.height ?? 32, 64));
    const body: Record<string, unknown> = {
        description: opts.description,
        image_size: { width: w, height: h },
    };
    if (opts.isoShape) body.isometric_tile_shape = opts.isoShape;
    if (opts.isoTileSize) body.isometric_tile_size = opts.isoTileSize;
    if (opts.seed !== undefined) body.seed = opts.seed;
    if (opts.textGuidanceScale !== undefined) body.text_guidance_scale = opts.textGuidanceScale;

    return submitAndPoll<CreateIsoTileResp>(
        '/create-isometric-tile',
        body,
        'tile_id',
        (id) => `/isometric-tiles/${id}`,
    );
}

export function extractIsoTileBuffer(resp: CreateIsoTileResp): Buffer | null {
    return decodeB64(resp.image?.base64 ?? resp.base64 ?? null);
}

// ── /map-objects ──────────────────────────────────────────────────────

export interface CreateMapObjectOptions {
    description: string;
    width: number;
    height: number;
    view?: 'low top-down' | 'high top-down' | 'side';
    backgroundImageBase64?: string;
    inpainting?: { type: 'oval' | 'rectangle'; x: number; y: number; w: number; h: number } |
                  { type: 'mask'; mask_base64: string };
    seed?: number;
    textGuidanceScale?: number;
}

export async function createMapObject(opts: CreateMapObjectOptions): Promise<CreateMapObjectResp> {
    const body: Record<string, unknown> = {
        description: opts.description,
        image_size: { width: opts.width, height: opts.height },
    };
    if (opts.view) body.view = opts.view;
    if (opts.seed !== undefined) body.seed = opts.seed;
    if (opts.textGuidanceScale !== undefined) body.text_guidance_scale = opts.textGuidanceScale;
    if (opts.backgroundImageBase64) {
        body.background_image = { type: 'base64', base64: opts.backgroundImageBase64, format: 'png' };
    }
    if (opts.inpainting) {
        if (opts.inpainting.type === 'mask') {
            body.inpainting = { type: 'mask', mask: { type: 'base64', base64: opts.inpainting.mask_base64, format: 'png' } };
        } else {
            body.inpainting = {
                type: opts.inpainting.type,
                x: opts.inpainting.x, y: opts.inpainting.y,
                width: opts.inpainting.w, height: opts.inpainting.h,
            };
        }
    }

    return submitAndPoll<CreateMapObjectResp>(
        '/map-objects',
        body,
        'object_id',
        (id) => `/objects/${id}`,
    );
}

export function extractMapObjectBuffer(resp: CreateMapObjectResp): Buffer | null {
    const first = resp.image?.base64 ?? resp.base64 ?? resp.images?.[0]?.base64 ?? null;
    return decodeB64(first);
}
