/**
 * Unified AI Asset Generation via fal.ai
 *
 * 2D Models:
 *   - SDXL          (fal-ai/fast-sdxl)         ~$0.00/img  — fast, free tier
 *   - Flux schnell  (fal-ai/flux/schnell)       $0.003/img  — quality, fast
 *   - Flux dev      (fal-ai/flux/dev)            $0.025/img  — highest quality 2D
 *
 * 3D Models:
 *   - Trellis       (fal-ai/trellis)             $0.02/gen   — fast image→3D
 *   - Hunyuan3D v3  (fal-ai/hunyuan3d-v3/*)      $0.375/gen  — highest quality 3D
 */

import { fal } from '@fal-ai/client';

// ── Configuration ────────────────────────────────────────────────────

// fal.ai reads FAL_KEY from env automatically, but we can also set it explicitly
const falKey = process.env.FAL_KEY;
if (falKey) {
    fal.config({ credentials: falKey });
}

// ── Types ────────────────────────────────────────────────────────────

export type Model2D = 'sdxl' | 'flux-schnell' | 'flux-dev';
export type Model3D = 'trellis' | 'hunyuan3d';

export interface Generate2DOptions {
    prompt: string;
    model?: Model2D;
    width?: number;
    height?: number;
    negativePrompt?: string;
    steps?: number;
    format?: 'png' | 'jpeg';
    style?: string;    // appended to prompt for game-asset styling
}

export interface Generate3DOptions {
    prompt?: string;        // text-to-3D (Hunyuan only)
    imageUrl?: string;      // image-to-3D (both Trellis and Hunyuan)
    model?: Model3D;
    textureSize?: number;
    enablePbr?: boolean;
}

export interface GenerationResult {
    success: boolean;
    imageUrl?: string;      // URL to download the generated image
    modelUrl?: string;      // URL to download the GLB model
    thumbnailUrl?: string;  // Preview image for 3D models
    width?: number;
    height?: number;
    model: string;          // fal.ai model ID used
    cost: number;           // estimated cost in USD
    error?: string;
}

// ── Pricing ──────────────────────────────────────────────────────────

export const PRICING = {
    'sdxl':          { label: 'SDXL',           cost: 0.00,   unit: 'per image',      speed: 'Fast' },
    'flux-schnell':  { label: 'Flux Schnell',   cost: 0.003,  unit: 'per megapixel',  speed: 'Fast' },
    'flux-dev':      { label: 'Flux Dev',       cost: 0.025,  unit: 'per megapixel',  speed: 'Medium' },
    'trellis':       { label: 'Trellis',        cost: 0.02,   unit: 'per model',      speed: 'Fast' },
    'hunyuan3d':     { label: 'Hunyuan3D v3',   cost: 0.375,  unit: 'per model',      speed: 'Slow' },
} as const;

// ── Size mapping ─────────────────────────────────────────────────────

type FalImageSize = 'square' | 'square_hd' | 'portrait_4_3' | 'portrait_16_9' | 'landscape_4_3' | 'landscape_16_9';

function toFalSize(w: number, h: number): FalImageSize {
    const ratio = w / h;
    if (Math.abs(ratio - 1) < 0.1) return w >= 768 ? 'square_hd' : 'square';
    if (ratio > 1) return ratio > 1.5 ? 'landscape_16_9' : 'landscape_4_3';
    return ratio < 0.67 ? 'portrait_16_9' : 'portrait_4_3';
}

// ── Style prompt helpers ─────────────────────────────────────────────

const STYLE_SUFFIXES: Record<string, string> = {
    pixel_art:    'pixel art style, retro, crisp pixels, no anti-aliasing',
    hand_drawn:   'hand-drawn illustration style, sketchy lines',
    vector:       'vector art, flat colors, clean edges, SVG-like',
    realistic:    'photorealistic, highly detailed, 8K quality',
    stylized:     'stylized game art, vibrant colors, game-ready',
    low_poly:     'low poly 3D style, minimal geometry, flat shading',
    pbr:          'PBR material, physically based, metallic roughness',
    hand_painted: 'hand-painted texture, painterly style',
};

function buildPrompt(prompt: string, style?: string, is3D = false): string {
    const parts = [prompt];
    if (style && STYLE_SUFFIXES[style]) {
        parts.push(STYLE_SUFFIXES[style]);
    }
    if (!is3D) {
        parts.push('game asset, transparent background, isolated object, no text');
    }
    return parts.join('. ');
}

// ── 2D Generation ────────────────────────────────────────────────────

const MODEL_2D_MAP: Record<Model2D, string> = {
    'sdxl':         'fal-ai/fast-sdxl',
    'flux-schnell': 'fal-ai/flux/schnell',
    'flux-dev':     'fal-ai/flux/dev',
};

export async function generate2D(opts: Generate2DOptions): Promise<GenerationResult> {
    const model = opts.model ?? 'flux-schnell';
    const falModel = MODEL_2D_MAP[model];
    const w = opts.width ?? 512;
    const h = opts.height ?? 512;
    const prompt = buildPrompt(opts.prompt, opts.style);

    try {
        const input: Record<string, unknown> = {
            prompt,
            image_size: toFalSize(w, h),
            num_images: 1,
            output_format: opts.format ?? 'png',
            enable_safety_checker: true,
        };

        if (opts.negativePrompt) {
            input.negative_prompt = opts.negativePrompt;
        }

        if (model === 'sdxl') {
            input.num_inference_steps = opts.steps ?? 25;
            input.guidance_scale = 7.5;
            input.format = opts.format ?? 'png';
            delete input.output_format;
        } else if (model === 'flux-schnell') {
            input.num_inference_steps = opts.steps ?? 4;
        } else {
            input.num_inference_steps = opts.steps ?? 28;
            input.guidance_scale = 3.5;
        }

        const result = await fal.subscribe(falModel, { input });
        const data = result.data as { images?: Array<{ url: string; width: number; height: number }> };
        const img = data.images?.[0];

        if (!img?.url) {
            return { success: false, model: falModel, cost: 0, error: 'No image returned from model' };
        }

        const megapixels = Math.ceil((img.width * img.height) / 1_000_000);
        const cost = model === 'sdxl' ? 0 : PRICING[model].cost * megapixels;

        return {
            success: true,
            imageUrl: img.url,
            width: img.width,
            height: img.height,
            model: falModel,
            cost,
        };
    } catch (err) {
        return {
            success: false,
            model: falModel,
            cost: 0,
            error: err instanceof Error ? err.message : 'Generation failed',
        };
    }
}

// ── 3D Generation ────────────────────────────────────────────────────

export async function generate3D(opts: Generate3DOptions): Promise<GenerationResult> {
    const model = opts.model ?? 'trellis';

    try {
        if (model === 'trellis') {
            return await generateTrellis(opts);
        } else {
            return await generateHunyuan(opts);
        }
    } catch (err) {
        return {
            success: false,
            model: model === 'trellis' ? 'fal-ai/trellis' : 'fal-ai/hunyuan3d-v3',
            cost: 0,
            error: err instanceof Error ? err.message : '3D generation failed',
        };
    }
}

async function generateTrellis(opts: Generate3DOptions): Promise<GenerationResult> {
    // Trellis requires an input image — if we only have text, generate an image first
    let imageUrl = opts.imageUrl;
    if (!imageUrl && opts.prompt) {
        const imgResult = await generate2D({
            prompt: opts.prompt,
            model: 'flux-schnell',
            style: 'stylized',
            width: 512,
            height: 512,
        });
        if (!imgResult.success || !imgResult.imageUrl) {
            return { success: false, model: 'fal-ai/trellis', cost: imgResult.cost, error: 'Failed to generate input image for 3D' };
        }
        imageUrl = imgResult.imageUrl;
    }

    if (!imageUrl) {
        return { success: false, model: 'fal-ai/trellis', cost: 0, error: 'Either prompt or imageUrl is required' };
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
        return { success: false, model: 'fal-ai/trellis', cost: PRICING.trellis.cost, error: 'No model returned' };
    }

    return {
        success: true,
        modelUrl: data.model_mesh.url,
        thumbnailUrl: imageUrl,
        model: 'fal-ai/trellis',
        cost: PRICING.trellis.cost + (opts.imageUrl ? 0 : PRICING['flux-schnell'].cost),
    };
}

async function generateHunyuan(opts: Generate3DOptions): Promise<GenerationResult> {
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
        return { success: false, model: 'fal-ai/hunyuan3d-v3', cost: 0, error: 'Either prompt or imageUrl required' };
    }

    const result = await fal.subscribe(endpoint, { input });
    const data = result.data as {
        model_glb?: { url: string };
        model_urls?: { glb?: string };
        thumbnail?: { url: string };
    };

    const modelUrl = data.model_glb?.url ?? data.model_urls?.glb;
    if (!modelUrl) {
        return { success: false, model: endpoint, cost: PRICING.hunyuan3d.cost, error: 'No model returned' };
    }

    return {
        success: true,
        modelUrl,
        thumbnailUrl: data.thumbnail?.url,
        model: endpoint,
        cost: PRICING.hunyuan3d.cost + (opts.enablePbr ? 0.15 : 0),
    };
}

// ── Convenience: download result to ArrayBuffer ──────────────────────

export async function downloadResult(url: string): Promise<ArrayBuffer> {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.arrayBuffer();
}
