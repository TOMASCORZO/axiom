/**
 * Axiom Engine — WASM Loader
 *
 * Detects whether the compiled WASM binary is available at /engine/axiom.wasm.
 * If available, signals to the rest of the app that the engine can be started.
 * If not, gracefully falls back to the animated canvas placeholder.
 */

export interface EngineAvailability {
    available: boolean;
    wasmSize: number | null;
    error: string | null;
}

let cached: EngineAvailability | null = null;

/**
 * Check if the compiled WASM engine binary is available.
 * The result is cached so subsequent calls are instant.
 */
export async function checkEngineAvailability(): Promise<EngineAvailability> {
    if (cached) return cached;

    try {
        const res = await fetch('/engine/axiom.wasm', { method: 'HEAD' });

        if (res.ok) {
            const contentLength = res.headers.get('content-length');
            cached = {
                available: true,
                wasmSize: contentLength ? parseInt(contentLength, 10) : null,
                error: null,
            };
        } else {
            cached = {
                available: false,
                wasmSize: null,
                error: 'Engine WASM binary not found. Run: scripts/build-engine.sh',
            };
        }
    } catch {
        cached = {
            available: false,
            wasmSize: null,
            error: 'Failed to check engine availability',
        };
    }

    return cached;
}

/**
 * Format byte size to human-readable string
 */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Invalidate the loader cache (e.g., after building the engine).
 */
export function invalidateLoaderCache(): void {
    cached = null;
}
