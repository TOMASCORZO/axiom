/**
 * Unified AI Asset Generation — PixelLab (2D pixel art & animation) + fal.ai/Replicate (3D)
 *
 * PixelLab API for pixel art:
 *   - Pixflux         ~$0.01   — native pixel art generation (up to 400×400)
 *   - Animate v3      ~$0.015  — text-driven sprite animation (4-16 frames)
 *
 * 3D Models (unchanged):
 *   - Trellis       fal $0.02                        — fast image→3D
 *   - Hunyuan3D     fal $0.375 | replicate $0.18     — high quality
 */

import { fal } from '@fal-ai/client';
import Replicate from 'replicate';

// ── PixelLab Configuration ──────────────────────────────────────────

const PIXELLAB_BASE = 'https://api.pixellab.ai/v2';
const pixelLabToken = process.env.PIXELLAB_API_TOKEN;

// ── 3D Provider Configuration (unchanged) ───────────────────────────

const falKey = process.env.FAL_KEY;
if (falKey) fal.config({ credentials: falKey });

const replicateToken = process.env.REPLICATE_API_TOKEN;
const replicate = replicateToken ? new Replicate({ auth: replicateToken }) : null;

// ── Types ────────────────────────────────────────────────────────────

export type Provider = 'pixellab' | 'fal' | 'replicate';
export type Model2D = 'pixflux' | 'pixflux-pro';
export type Model3D = 'trellis' | 'hunyuan3d';

export interface Generate2DOptions {
    prompt: string;
    model?: Model2D;
    provider?: Provider;
    width?: number;
    height?: number;
    negativePrompt?: string;
    steps?: number;
    format?: 'png' | 'jpeg';
    style?: string;
    noBackground?: boolean;
    /** PixelLab outline style */
    outline?: string;
    /** PixelLab shading level */
    shading?: string;
    /** PixelLab detail level */
    detail?: string;
    /** PixelLab view direction (e.g. 'side', 'top-down', '3/4') */
    view?: string;
    /** PixelLab facing direction (e.g. 'right', 'left', 'front') */
    direction?: string;
    /** Isometric projection */
    isometric?: boolean;
    loras?: Array<{ url: string; scale?: number }>;
}

export interface Generate3DOptions {
    prompt?: string;
    imageUrl?: string;
    model?: Model3D;
    provider?: Provider;
    textureSize?: number;
    enablePbr?: boolean;
}

export interface GenerationResult {
    success: boolean;
    imageUrl?: string;
    buffer?: ArrayBuffer;
    modelUrl?: string;
    thumbnailUrl?: string;
    width?: number;
    height?: number;
    model: string;
    provider: string;
    cost: number;
    error?: string;
}

export interface Img2ImgOptions {
    imageUrl: string;
    prompt: string;
    model?: Model2D;
    provider?: Provider;
    strength?: number;
    width?: number;
    height?: number;
    negativePrompt?: string;
    steps?: number;
    format?: 'png' | 'jpeg';
    style?: string;
}

export type ModelVideo = 'pixellab';

export interface AnimateOptions {
    sourceImageUrl: string;
    prompt: string;
    model?: ModelVideo;
    provider?: Provider;
    frameCount?: number;
    noBackground?: boolean;
}

export interface AnimationResult {
    success: boolean;
    /** Composed sprite sheet PNG buffer (frames arranged horizontally) */
    spriteSheetBuffer?: ArrayBuffer;
    frameWidth?: number;
    frameHeight?: number;
    frameCount?: number;
    model: string;
    provider: string;
    cost: number;
    error?: string;
}

// ── Pricing ──────────────────────────────────────────────────────────

export const PRICING = {
    pixellab: {
        'pixflux':      { label: 'Pixflux',          cost: 0.01,   unit: 'per image',  speed: 'Fast' },
        'pixflux-pro':  { label: 'Pixflux Pro',      cost: 0.013,  unit: 'per image',  speed: 'Medium' },
        'animate':      { label: 'Animate v3',       cost: 0.015,  unit: 'per anim',   speed: 'Medium' },
    },
    fal: {
        'trellis':   { label: 'Trellis',      cost: 0.02,  unit: 'per model', speed: 'Fast' },
        'hunyuan3d': { label: 'Hunyuan3D v3', cost: 0.375, unit: 'per model', speed: 'Slow' },
    },
    replicate: {
        'trellis':   { label: 'Trellis',      cost: 0.02,  unit: 'per model', speed: 'Fast' },
        'hunyuan3d': { label: 'Hunyuan3D v2', cost: 0.18,  unit: 'per model', speed: 'Slow' },
    },
} as const;

// =====================================================================
// PIXELLAB API HELPERS
// =====================================================================

interface PixelLabImage {
    type: 'base64';
    base64: string;
    format: 'png' | 'jpeg';
}

interface PixelLabResponse {
    // Some endpoints wrap in success/data/error, some return data directly
    success?: boolean;
    data?: Record<string, unknown>;
    error?: string | null;
    usage?: { credits_used?: number; remaining_credits?: number };
    // Direct fields (some endpoints)
    image?: PixelLabImage;
    images?: PixelLabImage[];
    background_job_id?: string;
    // Character endpoints
    character_id?: string;
}

async function pixelLabPost(endpoint: string, body: unknown, initialTimeoutMs = 120_000): Promise<PixelLabResponse> {
    if (!pixelLabToken) {
        throw new Error('PIXELLAB_API_TOKEN not set — get your key at https://pixellab.ai/account');
    }

    const res = await fetch(`${PIXELLAB_BASE}${endpoint}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${pixelLabToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(initialTimeoutMs),
    });

    if (res.status === 202) {
        // Async job — poll for completion
        const data = await res.json();
        const jobId = data.background_job_id ?? data.data?.background_job_id;
        if (!jobId) throw new Error('Async endpoint returned 202 but no job ID');
        return pollBackgroundJob(jobId);
    }

    if (!res.ok) {
        const raw = await res.text().catch(() => '');
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        const body = parsed as { error?: string; detail?: unknown; message?: string };
        console.error(`[pixellab] ${endpoint} ${res.status} →`, raw.slice(0, 1000));
        let msg: string;
        if (typeof body === 'object' && body !== null) {
            msg = body.error || body.message ||
                (typeof body.detail === 'string' ? body.detail :
                    body.detail !== undefined ? JSON.stringify(body.detail).slice(0, 400) :
                        `PixelLab ${endpoint} HTTP ${res.status}`);
        } else {
            msg = raw.slice(0, 400) || `PixelLab ${endpoint} HTTP ${res.status}`;
        }
        throw new Error(`PixelLab ${endpoint} ${res.status}: ${msg}`);
    }

    return res.json();
}

async function pixelLabGet(endpoint: string): Promise<PixelLabResponse> {
    if (!pixelLabToken) throw new Error('PIXELLAB_API_TOKEN not set');

    const res = await fetch(`${PIXELLAB_BASE}${endpoint}`, {
        headers: { 'Authorization': `Bearer ${pixelLabToken}` },
        signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
        if (res.status === 423) throw new Error('STILL_PROCESSING');
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errBody.error || `PixelLab API error: ${res.status}`);
    }

    return res.json();
}

async function pollBackgroundJob(jobId: string, maxAttempts = 110): Promise<PixelLabResponse> {
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
            const result = await pixelLabGet(`/background-jobs/${jobId}`);
            return result; // 200 = done
        } catch (err) {
            if (err instanceof Error && err.message === 'STILL_PROCESSING') continue;
            throw err;
        }
    }
    throw new Error(`PixelLab job ${jobId} timed out after ${maxAttempts * 2}s`);
}

/** Convert an image URL to PixelLab base64 image input format (raw base64, no data URL prefix). */
async function imageUrlToBase64(url: string): Promise<PixelLabImage> {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
    const arrayBuf = await res.arrayBuffer();
    const base64 = Buffer.from(arrayBuf).toString('base64');
    const contentType = res.headers.get('content-type') || 'image/png';
    const format = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpeg' : 'png';
    return { type: 'base64', base64, format } as PixelLabImage;
}

/**
 * Fetch an arbitrary image URL, normalize to PNG via Sharp, and return it as a
 * PixelLab PixelImage payload with a proper `data:image/png;base64,...` data URL.
 * Also returns the normalized image dimensions (needed by /image-to-pixelart's
 * `image_size` field). Resizes to `maxSide` if the longest side exceeds it.
 */
async function fetchImageAsPixelLabInput(url: string, maxSide = 1024): Promise<{ pixelImage: PixelLabImage; width: number; height: number }> {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
    const arrayBuf = await res.arrayBuffer();

    const sharp = (await import('sharp')).default;
    let pipeline = sharp(Buffer.from(arrayBuf));
    const meta = await pipeline.metadata();
    const srcW = meta.width ?? 0;
    const srcH = meta.height ?? 0;
    if (!srcW || !srcH) throw new Error('Could not read source image dimensions');

    const longest = Math.max(srcW, srcH);
    if (longest > maxSide) {
        const scale = maxSide / longest;
        pipeline = pipeline.resize(Math.round(srcW * scale), Math.round(srcH * scale));
    }

    const pngBuffer = await pipeline.png().toBuffer();
    const finalMeta = await sharp(pngBuffer).metadata();
    const width = finalMeta.width ?? srcW;
    const height = finalMeta.height ?? srcH;

    const base64 = pngBuffer.toString('base64');
    const pixelImage: PixelLabImage = {
        type: 'base64',
        base64,
        format: 'png',
    };
    return { pixelImage, width, height };
}

/** Decode a PixelLab base64 field, tolerating an optional `data:image/...;base64,` prefix. */
function decodeBase64Field(b64: string | undefined): Buffer | null {
    if (!b64) return null;
    const commaIdx = b64.indexOf(',');
    const payload = b64.startsWith('data:') && commaIdx >= 0 ? b64.slice(commaIdx + 1) : b64;
    return Buffer.from(payload, 'base64');
}

/** Extract image buffer from PixelLab response (handles multiple response formats). */
function extractImageBuffer(response: PixelLabResponse): Buffer | null {
    // Try: response.image
    const img = response.image ?? (response.data?.image as PixelLabImage | undefined);
    const fromSingle = decodeBase64Field(img?.base64);
    if (fromSingle) return fromSingle;

    // Try: response.images[0]
    const images = response.images ?? (response.data?.images as PixelLabImage[] | undefined);
    const fromFirst = decodeBase64Field(images?.[0]?.base64);
    if (fromFirst) return fromFirst;

    // Try: response.data.base64 (direct)
    const fromDirect = decodeBase64Field(response.data?.base64 as string | undefined);
    if (fromDirect) return fromDirect;

    return null;
}

/** Extract multiple image buffers from PixelLab response (for animations). */
function extractImageBuffers(response: PixelLabResponse): Buffer[] {
    const images = response.images ?? (response.data?.images as PixelLabImage[] | undefined);
    if (images?.length) {
        return images.map(img => decodeBase64Field(img.base64)).filter((b): b is Buffer => b !== null);
    }

    // Fallback: try single image
    const single = extractImageBuffer(response);
    return single ? [single] : [];
}

// =====================================================================
// 2D GENERATION (PixelLab Pixflux)
// =====================================================================

export async function generate2D(opts: Generate2DOptions): Promise<GenerationResult> {
    const model = opts.model ?? 'pixflux';
    const w = Math.min(Math.max(opts.width ?? 64, 16), 400);
    const h = Math.min(Math.max(opts.height ?? 64, 16), 400);

    try {
        const body: Record<string, unknown> = {
            description: opts.prompt,
            image_size: { width: w, height: h },
            no_background: opts.noBackground !== false, // default true
        };

        if (opts.outline) body.outline = opts.outline;
        if (opts.shading) body.shading = opts.shading;
        if (opts.detail) body.detail = opts.detail;
        if (opts.view) body.view = opts.view;
        if (opts.direction) body.direction = opts.direction;
        if (opts.isometric !== undefined) body.isometric = opts.isometric;

        const endpoint = model === 'pixflux-pro' ? '/generate-image-v2' : '/create-image-pixflux';
        const response = await pixelLabPost(endpoint, body);
        const buffer = extractImageBuffer(response);

        if (!buffer) {
            console.error('[pixellab] Unexpected response shape:', JSON.stringify(response).slice(0, 500));
            return { success: false, model, provider: 'pixellab', cost: 0, error: 'No image in PixelLab response' };
        }

        const cost = response.usage?.credits_used ?? PRICING.pixellab[model]?.cost ?? 0.01;
        return {
            success: true,
            buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
            width: w,
            height: h,
            model,
            provider: 'pixellab',
            cost,
        };
    } catch (err) {
        return {
            success: false,
            model,
            provider: 'pixellab',
            cost: 0,
            error: err instanceof Error ? err.message : 'PixelLab generation failed',
        };
    }
}

// =====================================================================
// IMAGE-TO-PIXELART (PixelLab /image-to-pixelart — photo → pixel art)
// =====================================================================

/**
 * Call PixelLab's `/remove-background` endpoint on an already-pixelated PNG
 * buffer. Returns a transparent-background PNG. Max 400×400 per PixelLab spec.
 */
async function pixelLabRemoveBackground(
    pngBuffer: Buffer,
    width: number,
    height: number,
    textHint?: string,
): Promise<{ buffer: Buffer; cost: number } | { error: string }> {
    try {
        const body: Record<string, unknown> = {
            image: { type: 'base64', base64: pngBuffer.toString('base64'), format: 'png' },
            image_size: { width, height },
            background_removal_task: 'remove_complex_background',
        };
        // PixelLab's /remove-background field is `text`, not `text_hint`.
        if (textHint && textHint.trim()) body.text = textHint.trim().slice(0, 500);

        const response = await pixelLabPost('/remove-background', body);
        const out = extractImageBuffer(response);
        if (!out) {
            console.error('[pixellab] Unexpected /remove-background response:', JSON.stringify(response).slice(0, 500));
            return { error: 'No image in /remove-background response' };
        }
        return { buffer: out, cost: response.usage?.credits_used ?? 0 };
    } catch (err) {
        return { error: err instanceof Error ? err.message : '/remove-background failed' };
    }
}

/**
 * Convert a photo into a transparent-background pixel art sprite using
 * PixelLab's dedicated `/image-to-pixelart` endpoint (faithful pixelization),
 * then pipe the result through `/remove-background` for matting. Two calls,
 * but both endpoints are stable — the single-call `/create-image-pixflux` path
 * with init_image + no_background returns opaque 500s from PixelLab's side.
 *
 * Prompt is used as a text_hint for /remove-background matting only; the
 * pixelization itself is prompt-less (faithful to the source).
 */
export async function imageToPixelArt(opts: {
    imageUrl: string;
    prompt?: string;
    outputWidth?: number;
    outputHeight?: number;
}): Promise<GenerationResult> {
    try {
        // /image-to-pixelart input image_size ≤ 1280×1280, output_size ≤ 320×320.
        const { pixelImage, width: srcW, height: srcH } = await fetchImageAsPixelLabInput(opts.imageUrl, 1280);

        const MAX_OUT = 320;
        const MIN_OUT = 16;
        let outW: number;
        let outH: number;
        if (opts.outputWidth && opts.outputHeight) {
            outW = Math.min(Math.max(opts.outputWidth, MIN_OUT), MAX_OUT);
            outH = Math.min(Math.max(opts.outputHeight, MIN_OUT), MAX_OUT);
        } else {
            const longest = Math.max(srcW, srcH);
            const scale = Math.min(1, 128 / longest);
            outW = Math.max(MIN_OUT, Math.round(srcW * scale));
            outH = Math.max(MIN_OUT, Math.round(srcH * scale));
        }

        const pixelateBody = {
            image: pixelImage,
            image_size: { width: srcW, height: srcH },
            output_size: { width: outW, height: outH },
        };

        const response = await pixelLabPost('/image-to-pixelart', pixelateBody);
        let buffer = extractImageBuffer(response);

        if (!buffer) {
            console.error('[pixellab] Unexpected /image-to-pixelart response:', JSON.stringify(response).slice(0, 500));
            return { success: false, model: 'image-to-pixelart', provider: 'pixellab', cost: 0, error: 'No image in /image-to-pixelart response' };
        }

        let cost = response.usage?.credits_used ?? 0.01;

        // Strip background via dedicated matting endpoint. Failures here are
        // surfaced — silently returning an opaque image makes it look like
        // the bg removal "worked" when it didn't.
        const bgResult = await pixelLabRemoveBackground(buffer, outW, outH, opts.prompt);
        if ('error' in bgResult) {
            return {
                success: false,
                model: 'image-to-pixelart',
                provider: 'pixellab',
                cost,
                error: `Background removal failed: ${bgResult.error}`,
            };
        }
        buffer = bgResult.buffer;
        cost += bgResult.cost;

        return {
            success: true,
            buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
            width: outW,
            height: outH,
            model: 'image-to-pixelart',
            provider: 'pixellab',
            cost,
        };
    } catch (err) {
        return {
            success: false,
            model: 'image-to-pixelart',
            provider: 'pixellab',
            cost: 0,
            error: err instanceof Error ? err.message : 'PixelLab /image-to-pixelart failed',
        };
    }
}

// =====================================================================
// IMG2IMG (PixelLab Pixflux with init_image — text-guided variation)
// =====================================================================

export async function img2img(opts: Img2ImgOptions): Promise<GenerationResult> {
    const w = Math.min(Math.max(opts.width ?? 64, 16), 400);
    const h = Math.min(Math.max(opts.height ?? 64, 16), 400);

    try {
        const initImage = await imageUrlToBase64(opts.imageUrl);

        // Map strength (0-1) to text_guidance_scale (1-20)
        // Low strength = close to original = low guidance, High strength = more creative = high guidance
        const strength = opts.strength ?? 0.5;
        const textGuidance = Math.round(1 + strength * 19);

        const body: Record<string, unknown> = {
            description: opts.prompt,
            image_size: { width: w, height: h },
            init_image: initImage,
            text_guidance_scale: textGuidance,
            no_background: true,
        };

        const response = await pixelLabPost('/create-image-pixflux', body);
        const buffer = extractImageBuffer(response);

        if (!buffer) {
            return { success: false, model: 'pixflux', provider: 'pixellab', cost: 0, error: 'No image in img2img response' };
        }

        const cost = response.usage?.credits_used ?? 0.01;
        return {
            success: true,
            buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
            width: w,
            height: h,
            model: 'pixflux',
            provider: 'pixellab',
            cost,
        };
    } catch (err) {
        return {
            success: false,
            model: 'pixflux',
            provider: 'pixellab',
            cost: 0,
            error: err instanceof Error ? err.message : 'PixelLab img2img failed',
        };
    }
}

// =====================================================================
// ANIMATION (PixelLab animate-with-text-v3 → sprite sheet)
// =====================================================================

/**
 * Generate animation frames from a source image using PixelLab's text-driven animation.
 * Returns a composed sprite sheet (frames arranged horizontally) ready for game use.
 *
 * PixelLab's 24GB GPU runs CUDA OOM at the documented 256×256 / 524k-pixel
 * ceiling, so we resize the source to ≤128×128 up front — at that size even
 * 16 frames (128×128×16 = 262,144 px) fits comfortably within what the GPU
 * actually handles, and the whole call stays well under Vercel's 300s limit.
 *
 * Any input format (PNG, JPEG, WebP, GIF) is accepted.
 */
export async function generateAnimation(opts: AnimateOptions): Promise<AnimationResult> {
    // Force even, clamp 4-16.
    let frameCount = opts.frameCount ?? 6;
    if (frameCount % 2 !== 0) frameCount += 1;
    frameCount = Math.min(Math.max(frameCount, 4), 16);

    try {
        // Resize ≤128×128 — conservative enough to avoid PixelLab CUDA OOM.
        const { pixelImage: firstFrame } =
            await fetchImageAsPixelLabInput(opts.sourceImageUrl, 128);

        const body = {
            first_frame: firstFrame,
            action: opts.prompt.slice(0, 500),
            frame_count: frameCount,
            no_background: opts.noBackground !== false,
        };

        // /animate-with-text-v3 is synchronous — PixelLab holds the connection
        // open while the model runs on their GPU. Give it a long timeout
        // (270s) so Vercel's 300s serverless cap still leaves headroom for
        // Sharp compositing + upload.
        const response = await pixelLabPost('/animate-with-text-v3', body, 270_000);
        const frames = extractImageBuffers(response);

        if (frames.length === 0) {
            console.error('[pixellab] No animation frames in response:', JSON.stringify(response).slice(0, 500));
            return { success: false, model: 'animate-v3', provider: 'pixellab', cost: 0, error: 'No frames in animation response' };
        }

        // Compose frames into horizontal sprite sheet using Sharp
        const sharp = (await import('sharp')).default;
        const firstMeta = await sharp(frames[0]).metadata();
        if (!firstMeta.width || !firstMeta.height) {
            return { success: false, model: 'animate-v3', provider: 'pixellab', cost: 0, error: 'Could not read frame dimensions from PixelLab response' };
        }
        const fw = firstMeta.width;
        const fh = firstMeta.height;

        // Ensure all frames are the same size (resize if needed)
        const normalizedFrames = await Promise.all(
            frames.map(f => sharp(f).resize(fw, fh).png().toBuffer())
        );

        const spriteSheet = await sharp({
            create: {
                width: fw * normalizedFrames.length,
                height: fh,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 },
            },
        })
        .composite(normalizedFrames.map((frame, i) => ({
            input: frame,
            left: i * fw,
            top: 0,
        })))
        .png()
        .toBuffer();

        const cost = response.usage?.credits_used ?? PRICING.pixellab.animate.cost;
        return {
            success: true,
            spriteSheetBuffer: spriteSheet.buffer.slice(spriteSheet.byteOffset, spriteSheet.byteOffset + spriteSheet.byteLength) as ArrayBuffer,
            frameWidth: fw,
            frameHeight: fh,
            frameCount: normalizedFrames.length,
            model: 'animate-v3',
            provider: 'pixellab',
            cost,
        };
    } catch (err) {
        return {
            success: false,
            model: 'animate-v3',
            provider: 'pixellab',
            cost: 0,
            error: err instanceof Error ? err.message : 'PixelLab animation failed',
        };
    }
}

// =====================================================================
// 3D GENERATION (fal.ai + Replicate — unchanged)
// =====================================================================

function pick3DProvider(preferred?: Provider): 'fal' | 'replicate' {
    if (preferred === 'fal' && falKey) return 'fal';
    if (preferred === 'replicate' && replicateToken) return 'replicate';
    if (falKey) return 'fal';
    if (replicateToken) return 'replicate';
    return 'fal';
}

export async function generate3D(opts: Generate3DOptions): Promise<GenerationResult> {
    const provider = pick3DProvider(opts.provider);
    const model = opts.model ?? 'trellis';

    try {
        if (model === 'trellis') {
            if (!falKey) {
                return { success: false, model: 'trellis', provider: 'fal', cost: 0, error: 'Trellis requires FAL_KEY' };
            }
            return await generateTrellisFal(opts);
        } else {
            if (provider === 'replicate') return await generateHunyuanReplicate(opts);
            return await generateHunyuanFal(opts);
        }
    } catch (err) {
        return { success: false, model, provider, cost: 0, error: err instanceof Error ? err.message : '3D generation failed' };
    }
}

// Helper: generate a reference image for 3D (uses PixelLab if available, falls back to basic)
async function generateReferenceImage(prompt: string): Promise<string | null> {
    const result = await generate2D({ prompt, width: 256, height: 256, style: 'stylized' });
    if (result.success && result.buffer) {
        // Convert buffer to data URL for 3D model input
        const base64 = Buffer.from(result.buffer).toString('base64');
        return `data:image/png;base64,${base64}`;
    }
    return null;
}

async function generateTrellisFal(opts: Generate3DOptions): Promise<GenerationResult> {
    let imageUrl = opts.imageUrl;
    if (!imageUrl && opts.prompt) {
        imageUrl = await generateReferenceImage(opts.prompt) ?? undefined;
        if (!imageUrl) {
            return { success: false, model: 'fal-ai/trellis', provider: 'fal', cost: 0, error: 'Failed to generate input image for 3D' };
        }
    }

    if (!imageUrl) {
        return { success: false, model: 'fal-ai/trellis', provider: 'fal', cost: 0, error: 'Either prompt or imageUrl is required' };
    }

    const result = await fal.subscribe('fal-ai/trellis', {
        input: {
            image_url: imageUrl,
            texture_size: String(opts.textureSize ?? 1024) as "512" | "1024" | "2048",
            ss_sampling_steps: 12,
            slat_sampling_steps: 12,
        },
    });

    const data = result.data as { model_mesh?: { url: string } };
    if (!data.model_mesh?.url) {
        return { success: false, model: 'fal-ai/trellis', provider: 'fal', cost: PRICING.fal.trellis.cost, error: 'No model returned' };
    }

    return {
        success: true,
        modelUrl: data.model_mesh.url,
        thumbnailUrl: imageUrl,
        model: 'fal-ai/trellis',
        provider: 'fal',
        cost: PRICING.fal.trellis.cost,
    };
}

async function generateHunyuanFal(opts: Generate3DOptions): Promise<GenerationResult> {
    let endpoint: string;
    const input: Record<string, unknown> = {
        enable_pbr: opts.enablePbr ?? false,
        face_count: 500000,
        generate_type: 'Normal',
    };

    if (opts.imageUrl) {
        endpoint = 'fal-ai/hunyuan3d-v3/image-to-3d';
        input.input_image_url = opts.imageUrl;
    } else if (opts.prompt) {
        endpoint = 'fal-ai/hunyuan3d-v3/text-to-3d';
        input.prompt = opts.prompt;
    } else {
        return { success: false, model: 'fal-ai/hunyuan3d-v3', provider: 'fal', cost: 0, error: 'Either prompt or imageUrl required' };
    }

    const result = await fal.subscribe(endpoint, { input });
    const data = result.data as {
        model_glb?: { url: string };
        model_urls?: { glb?: string };
        thumbnail?: { url: string };
    };

    const modelUrl = data.model_glb?.url ?? data.model_urls?.glb;
    if (!modelUrl) {
        return { success: false, model: endpoint, provider: 'fal', cost: PRICING.fal.hunyuan3d.cost, error: 'No model returned' };
    }

    return {
        success: true,
        modelUrl,
        thumbnailUrl: data.thumbnail?.url,
        model: endpoint,
        provider: 'fal',
        cost: PRICING.fal.hunyuan3d.cost + (opts.enablePbr ? 0.15 : 0),
    };
}

async function generateHunyuanReplicate(opts: Generate3DOptions): Promise<GenerationResult> {
    if (!replicate) {
        return { success: false, model: 'tencent/hunyuan3d-2', provider: 'replicate', cost: 0, error: 'REPLICATE_API_TOKEN not set' };
    }

    let imageUrl = opts.imageUrl;
    if (!imageUrl && opts.prompt) {
        imageUrl = await generateReferenceImage(opts.prompt) ?? undefined;
        if (!imageUrl) {
            return { success: false, model: 'tencent/hunyuan3d-2', provider: 'replicate', cost: 0, error: 'Failed to generate input image for 3D' };
        }
    }

    if (!imageUrl) {
        return { success: false, model: 'tencent/hunyuan3d-2', provider: 'replicate', cost: 0, error: 'Either prompt or imageUrl required' };
    }

    try {
        const output = await replicate.run('tencent/hunyuan3d-2' as `${string}/${string}`, {
            input: { image: imageUrl },
        });

        let modelUrl: string | null = null;
        if (typeof output === 'string') {
            modelUrl = output;
        } else if (Array.isArray(output) && output.length > 0) {
            modelUrl = typeof output[0] === 'string' ? output[0] : null;
        } else if (output && typeof output === 'object' && 'url' in (output as Record<string, unknown>)) {
            modelUrl = (output as { url: string }).url;
        }

        if (!modelUrl) {
            return { success: false, model: 'tencent/hunyuan3d-2', provider: 'replicate', cost: PRICING.replicate.hunyuan3d.cost, error: 'No model URL in response' };
        }

        return {
            success: true,
            modelUrl,
            thumbnailUrl: imageUrl,
            model: 'tencent/hunyuan3d-2',
            provider: 'replicate',
            cost: PRICING.replicate.hunyuan3d.cost,
        };
    } catch (err) {
        return { success: false, model: 'tencent/hunyuan3d-2', provider: 'replicate', cost: 0, error: err instanceof Error ? err.message : 'Replicate 3D failed' };
    }
}

// ── Download helper ──────────────────────────────────────────────────

export async function downloadResult(url: string): Promise<ArrayBuffer> {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.arrayBuffer();
}

// ── Background Removal ──────────────────────────────────────────────

/**
 * Remove background from an image using Sharp threshold.
 * Kept as a fallback — PixelLab's `no_background` param handles most cases.
 */
export async function removeBackground(input: string | ArrayBuffer): Promise<{ success: boolean; buffer?: ArrayBuffer; error?: string }> {
    const sharp = (await import('sharp')).default;
    try {
        let buf: Buffer;
        if (typeof input === 'string') {
            const res = await fetch(input);
            buf = Buffer.from(await res.arrayBuffer());
        } else {
            buf = Buffer.from(input);
        }

        const img = sharp(buf).ensureAlpha();
        const { width, height } = await img.metadata();
        if (!width || !height) {
            return { success: false, error: 'Could not read image dimensions' };
        }

        const raw = await img.raw().toBuffer();
        const THRESHOLD = 230;
        for (let i = 0; i < raw.length; i += 4) {
            if (raw[i] >= THRESHOLD && raw[i + 1] >= THRESHOLD && raw[i + 2] >= THRESHOLD) {
                raw[i + 3] = 0;
            }
        }

        const result = await sharp(raw, { raw: { width, height, channels: 4 } })
            .png()
            .toBuffer();

        return { success: true, buffer: result.buffer as ArrayBuffer };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Background removal failed' };
    }
}
