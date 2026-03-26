/**
 * Provider Request Throttle
 *
 * Ensures a minimum interval between API calls per provider.
 * Prevents 429s by spacing requests progressively. If a 429 still
 * occurs, the interval doubles automatically and recovers over time.
 *
 * Works in serverless (Next.js) — state lives in module-level globals
 * which persist within the same Node.js process.
 */

interface ThrottleState {
    /** Timestamp of the last completed request */
    lastRequestAt: number;
    /** Current minimum interval in ms (adaptive) */
    intervalMs: number;
    /** Base interval — we never go below this */
    baseIntervalMs: number;
    /** How many consecutive 429s we've seen */
    consecutive429s: number;
}

const _state = new Map<string, ThrottleState>();

/** Default intervals per provider (ms between requests) */
const PROVIDER_INTERVALS: Record<string, number> = {
    kimi: 8000,      // Moonshot: conservative, their servers overload easily
    deepseek: 3000,  // DeepSeek: moderate
    gpt: 1500,       // OpenAI: generous limits
    claude: 1500,    // Anthropic: generous limits
    gemini: 2000,    // Google: moderate
};

function getState(providerId: string): ThrottleState {
    let s = _state.get(providerId);
    if (!s) {
        const base = PROVIDER_INTERVALS[providerId] ?? 2000;
        s = { lastRequestAt: 0, intervalMs: base, baseIntervalMs: base, consecutive429s: 0 };
        _state.set(providerId, s);
    }
    return s;
}

/**
 * Wait the minimum time needed before sending a request.
 * Call this BEFORE every API fetch.
 */
export async function throttle(providerId: string): Promise<void> {
    const s = getState(providerId);
    const now = Date.now();
    const elapsed = now - s.lastRequestAt;
    const remaining = s.intervalMs - elapsed;

    if (remaining > 0) {
        await new Promise(r => setTimeout(r, remaining));
    }

    s.lastRequestAt = Date.now();
}

/**
 * Notify that a 429 was received. Doubles the interval (up to 60s)
 * and returns the recommended wait time before retrying.
 */
export function on429(providerId: string): number {
    const s = getState(providerId);
    s.consecutive429s += 1;

    // Double interval on each consecutive 429, cap at 60s
    s.intervalMs = Math.min(s.intervalMs * 2, 60000);

    // Recommended wait: exponential backoff + jitter
    const waitMs = Math.min(
        s.intervalMs + Math.random() * 2000,
        60000,
    );

    return Math.ceil(waitMs);
}

/**
 * Notify that a request succeeded. Gradually recovers the interval
 * back toward the base.
 */
export function onSuccess(providerId: string): void {
    const s = getState(providerId);
    if (s.consecutive429s > 0) {
        s.consecutive429s = 0;
        // Recover halfway toward base on first success after 429s
        s.intervalMs = Math.max(
            s.baseIntervalMs,
            Math.ceil(s.intervalMs * 0.6),
        );
    }
}
