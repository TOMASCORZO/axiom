/**
 * Unified AI Asset Generation — fal.ai + Replicate
 *
 * Provider is auto-selected based on available env keys:
 *   FAL_KEY            → fal.ai
 *   REPLICATE_API_TOKEN → Replicate
 *
 * 2D Models:
 *   - SDXL          fal ~$0.00 | replicate ~$0.005   — fast
 *   - Flux schnell  fal $0.003 | replicate $0.003    — best value
 *   - Flux dev      fal $0.025 | replicate $0.025    — highest quality
 *
 * 3D Models:
 *   - Trellis       fal $0.02                        — fast image→3D
 *   - Hunyuan3D     fal $0.375 | replicate $0.18     — high quality
 */

import { fal } from '@fal-ai/client';
import Replicate from 'replicate';

// ── Configuration ────────────────────────────────────────────────────

const falKey = process.env.FAL_KEY;
if (falKey) fal.config({ credentials: falKey });

const replicateToken = process.env.REPLICATE_API_TOKEN;
const replicate = replicateToken ? new Replicate({ auth: replicateToken }) : null;

export type Provider = 'fal' | 'replicate';

/** Returns which providers are available based on env keys */
export function availableProviders(): Provider[] {
    const p: Provider[] = [];
    if (falKey) p.push('fal');
    if (replicateToken) p.push('replicate');
    return p;
}

function pickProvider(preferred?: Provider): Provider {
    if (preferred && (preferred === 'fal' ? falKey : replicateToken)) return preferred;
    if (falKey) return 'fal';
    if (replicateToken) return 'replicate';
    return 'fal'; // will fail with a clear error
}

// ── Types ────────────────────────────────────────────────────────────

export type Model2D = 'sdxl' | 'flux-schnell' | 'flux-dev';
export type Model3D = 'trellis' | 'hunyuan3d';

export interface LoraWeight {
    url: string;       // HuggingFace URL, Civitai URL, or direct .safetensors URL
    scale?: number;    // 0.0–2.0, default 1.0
}

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
    loras?: LoraWeight[];
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
    modelUrl?: string;
    thumbnailUrl?: string;
    width?: number;
    height?: number;
    model: string;
    provider: Provider;
    cost: number;
    error?: string;
}

// ── Pricing ──────────────────────────────────────────────────────────

export const PRICING = {
    fal: {
        'sdxl':          { label: 'SDXL',           cost: 0.00,   unit: 'per image',     speed: 'Fast' },
        'flux-schnell':  { label: 'Flux Schnell',   cost: 0.003,  unit: 'per megapixel', speed: 'Fast' },
        'flux-dev':      { label: 'Flux Dev',       cost: 0.025,  unit: 'per megapixel', speed: 'Medium' },
        'trellis':       { label: 'Trellis',        cost: 0.02,   unit: 'per model',     speed: 'Fast' },
        'hunyuan3d':     { label: 'Hunyuan3D v3',   cost: 0.375,  unit: 'per model',     speed: 'Slow' },
        'kling':         { label: 'Kling v1',       cost: 0.065,  unit: 'per video',     speed: 'Medium' },
        'minimax':       { label: 'Minimax',        cost: 0.04,   unit: 'per video',     speed: 'Fast' },
        'wan':           { label: 'Wan 2.1',        cost: 0.04,   unit: 'per video',     speed: 'Medium' },
    },
    replicate: {
        'sdxl':          { label: 'SDXL',           cost: 0.005,  unit: 'per image',     speed: 'Fast' },
        'flux-schnell':  { label: 'Flux Schnell',   cost: 0.003,  unit: 'per image',     speed: 'Fast' },
        'flux-dev':      { label: 'Flux Dev',       cost: 0.025,  unit: 'per image',     speed: 'Medium' },
        'trellis':       { label: 'Trellis',        cost: 0.02,   unit: 'per model',     speed: 'Fast' },
        'hunyuan3d':     { label: 'Hunyuan3D v2',   cost: 0.18,   unit: 'per model',     speed: 'Slow' },
        'kling':         { label: 'Kling v2.6',     cost: 0.05,   unit: 'per video',     speed: 'Medium' },
        'minimax':       { label: 'Minimax',        cost: 0.05,   unit: 'per video',     speed: 'Fast' },
        'wan':           { label: 'Wan 2.1',        cost: 0.05,   unit: 'per video',     speed: 'Medium' },
    },
} as const;

// ── Helpers ──────────────────────────────────────────────────────────

type FalImageSize = 'square' | 'square_hd' | 'portrait_4_3' | 'portrait_16_9' | 'landscape_4_3' | 'landscape_16_9';

function toFalSize(w: number, h: number): FalImageSize {
    const ratio = w / h;
    if (Math.abs(ratio - 1) < 0.1) return w >= 768 ? 'square_hd' : 'square';
    if (ratio > 1) return ratio > 1.5 ? 'landscape_16_9' : 'landscape_4_3';
    return ratio < 0.67 ? 'portrait_16_9' : 'portrait_4_3';
}

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
    if (style && STYLE_SUFFIXES[style]) parts.push(STYLE_SUFFIXES[style]);
    if (!is3D) parts.push('game asset, transparent background, isolated object, no text');
    return parts.join('. ');
}

// =====================================================================
// 2D GENERATION
// =====================================================================

export async function generate2D(opts: Generate2DOptions): Promise<GenerationResult> {
    const provider = pickProvider(opts.provider);
    const model = opts.model ?? 'flux-schnell';

    if (provider === 'replicate') return generate2DReplicate(opts, model);
    return generate2DFal(opts, model);
}

// ── fal.ai 2D ────────────────────────────────────────────────────────

const FAL_2D_MAP: Record<Model2D, string> = {
    'sdxl':         'fal-ai/fast-sdxl',
    'flux-schnell': 'fal-ai/flux/schnell',
    'flux-dev':     'fal-ai/flux/dev',
};

async function generate2DFal(opts: Generate2DOptions, model: Model2D): Promise<GenerationResult> {
    const falModel = FAL_2D_MAP[model];
    // AI models need minimum resolution to produce quality output — generate at
    // model-native size, the caller (game tool) will downscale to game-asset size
    const minRes = model === 'sdxl' ? 512 : 1024;
    const w = Math.max(opts.width ?? 512, minRes);
    const h = Math.max(opts.height ?? 512, minRes);
    const prompt = buildPrompt(opts.prompt, opts.style);

    try {
        const input: Record<string, unknown> = {
            prompt,
            image_size: toFalSize(w, h),
            num_images: 1,
            output_format: opts.format ?? 'png',
            enable_safety_checker: true,
        };

        if (opts.negativePrompt) input.negative_prompt = opts.negativePrompt;

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

        // LoRA support — fal.ai accepts loras on SDXL and Flux models
        if (opts.loras?.length) {
            input.loras = opts.loras.map(l => ({ path: l.url, scale: l.scale ?? 1.0 }));
        }

        const result = await fal.subscribe(falModel, { input });
        const data = result.data as { images?: Array<{ url: string; width: number; height: number }> };
        const img = data.images?.[0];

        if (!img?.url) {
            return { success: false, model: falModel, provider: 'fal', cost: 0, error: 'No image returned' };
        }

        const megapixels = Math.ceil((img.width * img.height) / 1_000_000);
        const cost = model === 'sdxl' ? 0 : PRICING.fal[model].cost * megapixels;

        return { success: true, imageUrl: img.url, width: img.width, height: img.height, model: falModel, provider: 'fal', cost };
    } catch (err) {
        return { success: false, model: falModel, provider: 'fal', cost: 0, error: err instanceof Error ? err.message : 'fal.ai generation failed' };
    }
}

// ── Replicate 2D ─────────────────────────────────────────────────────

const REPLICATE_2D_MAP: Record<Model2D, string> = {
    'sdxl':         'stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc',
    'flux-schnell': 'black-forest-labs/flux-schnell',
    'flux-dev':     'black-forest-labs/flux-dev',
};

async function generate2DReplicate(opts: Generate2DOptions, model: Model2D): Promise<GenerationResult> {
    if (!replicate) {
        return { success: false, model: model, provider: 'replicate', cost: 0, error: 'REPLICATE_API_TOKEN not set' };
    }

    let repModel = REPLICATE_2D_MAP[model];
    // AI models need minimum resolution — generate at model-native size,
    // the caller (game tool) will downscale to game-asset size
    const minRes = model === 'sdxl' ? 512 : 1024;
    const w = Math.max(opts.width ?? 512, minRes);
    const h = Math.max(opts.height ?? 512, minRes);
    const prompt = buildPrompt(opts.prompt, opts.style);
    const hasLoras = opts.loras && opts.loras.length > 0;

    // Replicate uses a dedicated model for Flux + LoRA
    if (hasLoras && model === 'flux-dev') {
        repModel = 'lucataco/flux-dev-lora';
    }

    try {
        let input: Record<string, unknown>;

        if (model === 'sdxl') {
            input = {
                prompt,
                negative_prompt: opts.negativePrompt ?? 'blurry, low quality, text, watermark',
                width: Math.min(w, 1024),
                height: Math.min(h, 1024),
                num_outputs: 1,
                num_inference_steps: opts.steps ?? 25,
                guidance_scale: 7.5,
                output_format: opts.format ?? 'png',
            };
        } else {
            // Flux models
            input = {
                prompt,
                num_outputs: 1,
                output_format: opts.format ?? 'png',
                aspect_ratio: w === h ? '1:1' : w > h ? '16:9' : '9:16',
            };
            if (model === 'flux-schnell') {
                input.num_inference_steps = opts.steps ?? 8;
                input.go_fast = true;
            } else {
                input.num_inference_steps = opts.steps ?? 28;
                input.guidance = 3.5;
            }
        }

        // LoRA support for Replicate
        if (hasLoras) {
            const lora = opts.loras![0]; // Replicate typically takes one LoRA at a time
            if (model === 'flux-dev') {
                // lucataco/flux-dev-lora uses hf_lora param
                input.hf_lora = lora.url;
                input.lora_scale = lora.scale ?? 1.0;
            } else if (model === 'sdxl') {
                // SDXL on Replicate doesn't natively support LoRAs in the base model,
                // but some fine-tuned versions do. Pass as extra_lora_scale.
                input.lora_url = lora.url;
                input.lora_scale = lora.scale ?? 0.8;
            }
        }

        const output = await replicate.run(repModel as `${string}/${string}`, { input });

        // Replicate returns various formats:
        // - Array of URL strings (older models)
        // - Array of FileOutput objects with .url() method (newer SDK)
        // - Single FileOutput object
        // - ReadableStream
        let imageUrl: string | null = null;

        const extractUrl = (val: unknown): string | null => {
            if (typeof val === 'string') return val;
            if (val && typeof val === 'object') {
                // FileOutput objects have a .url() method or toString() that returns the URL
                if (typeof (val as { url: unknown }).url === 'function') {
                    const u = (val as { url: () => URL }).url();
                    return u?.href ?? String(u);
                }
                if ('href' in val) return (val as { href: string }).href;
                // Try toString — FileOutput.toString() returns the URL string
                const str = String(val);
                if (str.startsWith('http')) return str;
            }
            return null;
        };

        if (Array.isArray(output) && output.length > 0) {
            imageUrl = extractUrl(output[0]);
        } else {
            imageUrl = extractUrl(output);
        }

        if (!imageUrl) {
            return { success: false, model: repModel, provider: 'replicate', cost: 0, error: 'No image URL in Replicate response' };
        }

        const cost = PRICING.replicate[model].cost;
        return { success: true, imageUrl, width: w, height: h, model: repModel, provider: 'replicate', cost };
    } catch (err) {
        return { success: false, model: repModel, provider: 'replicate', cost: 0, error: err instanceof Error ? err.message : 'Replicate generation failed' };
    }
}

// =====================================================================
// 3D GENERATION
// =====================================================================

export async function generate3D(opts: Generate3DOptions): Promise<GenerationResult> {
    const provider = pickProvider(opts.provider);
    const model = opts.model ?? 'trellis';

    try {
        if (model === 'trellis') {
            // Trellis is only on fal.ai — use fal regardless of provider preference
            if (!falKey) {
                return { success: false, model: 'trellis', provider: 'fal', cost: 0, error: 'Trellis requires FAL_KEY' };
            }
            return await generateTrellisFal(opts);
        } else {
            // Hunyuan3D — available on both
            if (provider === 'replicate') return await generateHunyuanReplicate(opts);
            return await generateHunyuanFal(opts);
        }
    } catch (err) {
        return { success: false, model, provider, cost: 0, error: err instanceof Error ? err.message : '3D generation failed' };
    }
}

// ── fal.ai Trellis ───────────────────────────────────────────────────

async function generateTrellisFal(opts: Generate3DOptions): Promise<GenerationResult> {
    let imageUrl = opts.imageUrl;
    if (!imageUrl && opts.prompt) {
        const imgResult = await generate2D({ prompt: opts.prompt, model: 'flux-schnell', style: 'stylized', width: 512, height: 512, provider: 'fal' });
        if (!imgResult.success || !imgResult.imageUrl) {
            return { success: false, model: 'fal-ai/trellis', provider: 'fal', cost: imgResult.cost, error: 'Failed to generate input image for 3D' };
        }
        imageUrl = imgResult.imageUrl;
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
        cost: PRICING.fal.trellis.cost + (opts.imageUrl ? 0 : PRICING.fal['flux-schnell'].cost),
    };
}

// ── fal.ai Hunyuan3D ─────────────────────────────────────────────────

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

// ── Replicate Hunyuan3D ──────────────────────────────────────────────

async function generateHunyuanReplicate(opts: Generate3DOptions): Promise<GenerationResult> {
    if (!replicate) {
        return { success: false, model: 'tencent/hunyuan3d-2', provider: 'replicate', cost: 0, error: 'REPLICATE_API_TOKEN not set' };
    }

    // Hunyuan3D on Replicate needs an image — generate one if only text prompt
    let imageUrl = opts.imageUrl;
    if (!imageUrl && opts.prompt) {
        const imgResult = await generate2D({ prompt: opts.prompt, model: 'flux-schnell', style: 'stylized', width: 512, height: 512 });
        if (!imgResult.success || !imgResult.imageUrl) {
            return { success: false, model: 'tencent/hunyuan3d-2', provider: 'replicate', cost: imgResult.cost, error: 'Failed to generate input image for 3D' };
        }
        imageUrl = imgResult.imageUrl;
    }

    if (!imageUrl) {
        return { success: false, model: 'tencent/hunyuan3d-2', provider: 'replicate', cost: 0, error: 'Either prompt or imageUrl required' };
    }

    try {
        const output = await replicate.run('tencent/hunyuan3d-2' as `${string}/${string}`, {
            input: { image: imageUrl },
        });

        // Replicate returns the GLB URL directly or in an object
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

        const imgCost = opts.imageUrl ? 0 : PRICING.replicate['flux-schnell'].cost;
        return {
            success: true,
            modelUrl,
            thumbnailUrl: imageUrl,
            model: 'tencent/hunyuan3d-2',
            provider: 'replicate',
            cost: PRICING.replicate.hunyuan3d.cost + imgCost,
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
 * Remove background from an image using BiRefNet.
 * Accepts a public URL or a raw buffer.
 * Uses Replicate by default, falls back to fal.ai.
 */
export async function removeBackground(input: string | ArrayBuffer, provider?: Provider): Promise<{ success: boolean; imageUrl?: string; error?: string }> {
    const p = provider ?? pickProvider();

    try {
        // Resolve input to a public URL
        let imageUrl: string;
        if (typeof input === 'string') {
            imageUrl = input;
        } else if (p === 'fal' && falKey) {
            const blob = new Blob([input], { type: 'image/png' });
            imageUrl = await fal.storage.upload(blob);
        } else if (replicate) {
            // Replicate accepts data URIs directly
            const buf = Buffer.from(input);
            imageUrl = `data:image/png;base64,${buf.toString('base64')}`;
        } else {
            return { success: false, error: 'No provider available for background removal' };
        }

        if (p === 'replicate' && replicate) {
            const output = await replicate.run('lucataco/remove-bg:95fcc2a26d3899cd6c2691c900f7aefd65523a007f7fceeea83016e1e25e9a37' as `${string}/${string}`, {
                input: { image: imageUrl },
            });
            const raw = output as unknown;
            let resultUrl: string | null = null;
            if (typeof raw === 'string' && raw.startsWith('http')) {
                resultUrl = raw;
            } else if (raw && typeof raw === 'object') {
                const str = String(raw);
                if (str.startsWith('http')) resultUrl = str;
            }
            if (!resultUrl) {
                return { success: false, error: 'No image returned from Replicate background removal' };
            }
            return { success: true, imageUrl: resultUrl };
        }

        // fal.ai path
        if (!falKey) {
            return { success: false, error: 'FAL_KEY required for fal.ai background removal' };
        }
        const result = await fal.subscribe('fal-ai/birefnet', {
            input: { image_url: imageUrl },
        });
        const data = result.data as { image?: { url: string } };
        if (!data.image?.url) {
            return { success: false, error: 'No image returned from background removal' };
        }
        return { success: true, imageUrl: data.image.url };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Background removal failed' };
    }
}

// =====================================================================
// IMAGE-TO-IMAGE (img2img)
// =====================================================================

export interface Img2ImgOptions {
    imageUrl: string;          // Source image URL (public or data URI)
    prompt: string;
    model?: Model2D;
    provider?: Provider;
    strength?: number;         // 0.0–1.0 — how much to deviate from source (default 0.6)
    width?: number;
    height?: number;
    negativePrompt?: string;
    steps?: number;
    format?: 'png' | 'jpeg';
    style?: string;
}

export async function img2img(opts: Img2ImgOptions): Promise<GenerationResult> {
    const provider = pickProvider(opts.provider);
    const model = opts.model ?? 'flux-schnell';
    if (provider === 'replicate') return img2imgReplicate(opts, model);
    return img2imgFal(opts, model);
}

// ── fal.ai img2img ──────────────────────────────────────────────────

const FAL_IMG2IMG_MAP: Record<Model2D, string> = {
    'sdxl':         'fal-ai/fast-sdxl/image-to-image',
    'flux-schnell': 'fal-ai/flux/dev/image-to-image',   // schnell has no img2img, use dev
    'flux-dev':     'fal-ai/flux/dev/image-to-image',
};

async function img2imgFal(opts: Img2ImgOptions, model: Model2D): Promise<GenerationResult> {
    const falModel = FAL_IMG2IMG_MAP[model];
    const prompt = buildPrompt(opts.prompt, opts.style);
    const strength = opts.strength ?? 0.6;

    try {
        const input: Record<string, unknown> = {
            prompt,
            image_url: opts.imageUrl,
            strength,
            num_images: 1,
            output_format: opts.format ?? 'png',
            enable_safety_checker: true,
        };

        if (opts.negativePrompt) input.negative_prompt = opts.negativePrompt;

        if (model === 'sdxl') {
            input.num_inference_steps = opts.steps ?? 25;
            input.guidance_scale = 7.5;
        } else {
            input.num_inference_steps = opts.steps ?? 28;
            input.guidance_scale = 3.5;
        }

        const result = await fal.subscribe(falModel, { input });
        const data = result.data as { images?: Array<{ url: string; width: number; height: number }> };
        const img = data.images?.[0];

        if (!img?.url) {
            return { success: false, model: falModel, provider: 'fal', cost: 0, error: 'No image returned from img2img' };
        }

        return { success: true, imageUrl: img.url, width: img.width, height: img.height, model: falModel, provider: 'fal', cost: 0.025 };
    } catch (err) {
        return { success: false, model: falModel, provider: 'fal', cost: 0, error: err instanceof Error ? err.message : 'fal.ai img2img failed' };
    }
}

// ── Replicate img2img ───────────────────────────────────────────────

const REPLICATE_IMG2IMG_MAP: Record<Model2D, string> = {
    'sdxl':         'stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc',
    'flux-schnell': 'black-forest-labs/flux-dev',         // schnell has no img2img, use dev
    'flux-dev':     'black-forest-labs/flux-dev',
};

async function img2imgReplicate(opts: Img2ImgOptions, model: Model2D): Promise<GenerationResult> {
    if (!replicate) {
        return { success: false, model, provider: 'replicate', cost: 0, error: 'REPLICATE_API_TOKEN not set' };
    }

    const repModel = REPLICATE_IMG2IMG_MAP[model];
    const prompt = buildPrompt(opts.prompt, opts.style);
    const strength = opts.strength ?? 0.6;

    try {
        let input: Record<string, unknown>;

        if (model === 'sdxl') {
            input = {
                prompt,
                image: opts.imageUrl,
                prompt_strength: strength,
                negative_prompt: opts.negativePrompt ?? 'blurry, low quality, text, watermark',
                num_outputs: 1,
                num_inference_steps: opts.steps ?? 25,
                guidance_scale: 7.5,
                output_format: opts.format ?? 'png',
            };
        } else {
            // Flux dev img2img
            input = {
                prompt,
                image: opts.imageUrl,
                prompt_strength: strength,
                num_outputs: 1,
                output_format: opts.format ?? 'png',
                num_inference_steps: opts.steps ?? 28,
                guidance: 3.5,
            };
        }

        const output = await replicate.run(repModel as `${string}/${string}`, { input });

        let imageUrl: string | null = null;
        const extractUrl = (val: unknown): string | null => {
            if (typeof val === 'string') return val;
            if (val && typeof val === 'object') {
                if (typeof (val as { url: unknown }).url === 'function') {
                    const u = (val as { url: () => URL }).url();
                    return u?.href ?? String(u);
                }
                if ('href' in val) return (val as { href: string }).href;
                const str = String(val);
                if (str.startsWith('http')) return str;
            }
            return null;
        };

        if (Array.isArray(output) && output.length > 0) {
            imageUrl = extractUrl(output[0]);
        } else {
            imageUrl = extractUrl(output);
        }

        if (!imageUrl) {
            return { success: false, model: repModel, provider: 'replicate', cost: 0, error: 'No image URL in img2img response' };
        }

        return { success: true, imageUrl, model: repModel, provider: 'replicate', cost: 0.025 };
    } catch (err) {
        return { success: false, model: repModel, provider: 'replicate', cost: 0, error: err instanceof Error ? err.message : 'Replicate img2img failed' };
    }
}

// =====================================================================
// ANIMATION (image → video → frame extraction)
// =====================================================================

export type ModelVideo = 'kling' | 'minimax' | 'wan';

export interface AnimateOptions {
    sourceImageUrl: string;    // URL of the source static image
    prompt: string;            // Description of desired motion (e.g. "tractor driving", "ship rocking on waves")
    model?: ModelVideo;
    provider?: Provider;
    duration?: number;         // Video duration in seconds (default 5)
}

export interface AnimationResult {
    success: boolean;
    videoUrl?: string;         // URL of the generated video (mp4)
    model: string;
    provider: Provider;
    cost: number;
    error?: string;
}

const FAL_VIDEO_MAP: Record<ModelVideo, string> = {
    'kling':   'fal-ai/kling-video/v1/standard/image-to-video',
    'minimax': 'fal-ai/minimax-video/image-to-video',
    'wan':     'fal-ai/wan/v2.1/image-to-video',
};

const REPLICATE_VIDEO_MAP: Record<ModelVideo, string> = {
    'kling':   'kwaivgi/kling-v2.6',
    'minimax': 'minimax/video-01-live/image-to-video',
    'wan':     'wavespeedai/wan-2.1-i2v-480p',
};

/**
 * Generate a short video from a source image using an image-to-video model.
 * Returns a video URL — frame extraction into sprite sheets is handled by the caller.
 */
export async function generateAnimation(opts: AnimateOptions): Promise<AnimationResult> {
    const provider = pickProvider(opts.provider);
    const model = opts.model ?? 'kling';

    // Force plain white background so frames work cleanly on any game map/scene
    const prompt = `${opts.prompt}. Plain solid white background, no scenery, no environment, isolated subject on white`;
    const enriched = { ...opts, prompt };

    if (provider === 'fal') return generateAnimationFal(enriched, model);
    return generateAnimationReplicate(enriched, model);
}

// ── fal.ai Image-to-Video ───────────────────────────────────────────

async function generateAnimationFal(opts: AnimateOptions, model: ModelVideo): Promise<AnimationResult> {
    const falModel = FAL_VIDEO_MAP[model];
    const duration = opts.duration ?? 5;

    try {
        const input: Record<string, unknown> = {
            image_url: opts.sourceImageUrl,
            prompt: opts.prompt,
        };

        if (model === 'kling') {
            input.duration = String(duration) as '5' | '10';
        } else if (model === 'minimax') {
            input.prompt_optimizer = true;
        }

        const result = await fal.subscribe(falModel, { input });
        const data = result.data as { video?: { url: string } };

        if (!data.video?.url) {
            return { success: false, model: falModel, provider: 'fal', cost: 0, error: 'No video returned' };
        }

        const costs: Record<ModelVideo, number> = { kling: 0.065, minimax: 0.04, wan: 0.04 };
        return {
            success: true,
            videoUrl: data.video.url,
            model: falModel,
            provider: 'fal',
            cost: costs[model],
        };
    } catch (err) {
        return { success: false, model: falModel, provider: 'fal', cost: 0, error: err instanceof Error ? err.message : 'Video generation failed' };
    }
}

// ── Replicate Image-to-Video ────────────────────────────────────────

async function generateAnimationReplicate(opts: AnimateOptions, model: ModelVideo): Promise<AnimationResult> {
    if (!replicate) {
        return { success: false, model, provider: 'replicate', cost: 0, error: 'REPLICATE_API_TOKEN not set' };
    }

    const repModel = REPLICATE_VIDEO_MAP[model];

    try {
        const input: Record<string, unknown> = {
            image: opts.sourceImageUrl,
            prompt: opts.prompt,
        };

        if (model === 'kling') {
            input.duration = String(opts.duration ?? 5);
        }

        const output = await replicate.run(repModel as `${string}/${string}`, { input });

        let videoUrl: string | null = null;
        const raw = output as unknown;
        if (typeof raw === 'string' && raw.startsWith('http')) {
            videoUrl = raw;
        } else if (raw && typeof raw === 'object') {
            const str = String(raw);
            if (str.startsWith('http')) videoUrl = str;
        }

        if (!videoUrl) {
            return { success: false, model: repModel, provider: 'replicate', cost: 0, error: 'No video URL in response' };
        }

        return {
            success: true,
            videoUrl,
            model: repModel,
            provider: 'replicate',
            cost: 0.05,
        };
    } catch (err) {
        return { success: false, model: repModel, provider: 'replicate', cost: 0, error: err instanceof Error ? err.message : 'Replicate video generation failed' };
    }
}
