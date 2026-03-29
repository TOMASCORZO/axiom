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
    },
    replicate: {
        'sdxl':          { label: 'SDXL',           cost: 0.005,  unit: 'per image',     speed: 'Fast' },
        'flux-schnell':  { label: 'Flux Schnell',   cost: 0.003,  unit: 'per image',     speed: 'Fast' },
        'flux-dev':      { label: 'Flux Dev',       cost: 0.025,  unit: 'per image',     speed: 'Medium' },
        'trellis':       { label: 'Trellis',        cost: 0.02,   unit: 'per model',     speed: 'Fast' },
        'hunyuan3d':     { label: 'Hunyuan3D v2',   cost: 0.18,   unit: 'per model',     speed: 'Slow' },
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
    'sdxl':         'stability-ai/sdxl',
    'flux-schnell': 'black-forest-labs/flux-schnell',
    'flux-dev':     'black-forest-labs/flux-dev',
};

async function generate2DReplicate(opts: Generate2DOptions, model: Model2D): Promise<GenerationResult> {
    if (!replicate) {
        return { success: false, model: model, provider: 'replicate', cost: 0, error: 'REPLICATE_API_TOKEN not set' };
    }

    let repModel = REPLICATE_2D_MAP[model];
    const w = opts.width ?? 512;
    const h = opts.height ?? 512;
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
                input.num_inference_steps = opts.steps ?? 4;
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

        // Replicate returns array of URLs or a ReadableStream for Flux
        let imageUrl: string | null = null;
        if (Array.isArray(output) && output.length > 0) {
            const first = output[0];
            if (typeof first === 'string') {
                imageUrl = first;
            } else if (first && typeof first === 'object' && 'url' in first) {
                imageUrl = (first as { url: string }).url;
            }
        } else if (output && typeof output === 'object' && !Array.isArray(output) && 'url' in (output as Record<string, unknown>)) {
            imageUrl = (output as { url: string }).url;
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
