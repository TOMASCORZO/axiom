/**
 * Cost & Token Tracker
 * 
 * Provides continuous background tracking of API token consumption 
 * and exact USD calculations natively across sessions, ported from Claude Code.
 */

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
}

export interface SessionCost {
    totalUSD: number;
    usage: TokenUsage;
}

const PRICING_PER_MILLION = {
    'claude-3-7-sonnet-20250219': {
        input: 3.00,
        output: 15.00,
        cacheRead: 0.30,
        cacheWrite: 3.75
    },
    'claude-3-5-sonnet-20241022': {
        input: 3.00,
        output: 15.00,
        cacheRead: 0.30,
        cacheWrite: 3.75
    },
    'claude-3-haiku-20240307': {
        input: 0.25,
        output: 1.25,
        cacheRead: 0.03,
        cacheWrite: 0.30
    }
};

// Stateless tracker for the current instance (in reality, bound to Supabase db)
const sessionCosts = new Map<string, SessionCost>();

export function getSessionCost(sessionId: string): SessionCost {
    if (!sessionCosts.has(sessionId)) {
        sessionCosts.set(sessionId, {
            totalUSD: 0,
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
        });
    }
    return sessionCosts.get(sessionId)!;
}

/**
 * Calculates the exact USD cost of a specific API response and adds it to the session total.
 */
export function recordTokenUsage(sessionId: string, model: string, usage: TokenUsage): number {
    const pricing = PRICING_PER_MILLION[model as keyof typeof PRICING_PER_MILLION] || PRICING_PER_MILLION['claude-3-7-sonnet-20250219'];
    
    const cost = (
        (usage.inputTokens * pricing.input) +
        (usage.outputTokens * pricing.output) +
        (usage.cacheReadTokens * pricing.cacheRead) +
        (usage.cacheCreationTokens * pricing.cacheWrite)
    ) / 1_000_000;

    const session = getSessionCost(sessionId);
    session.totalUSD += cost;
    session.usage.inputTokens += usage.inputTokens;
    session.usage.outputTokens += usage.outputTokens;
    session.usage.cacheReadTokens += usage.cacheReadTokens;
    session.usage.cacheCreationTokens += usage.cacheCreationTokens;

    return cost;
}

export function formatCostDisplay(sessionId: string): string {
    const session = getSessionCost(sessionId);
    return [
        "==============================",
        "   SESSION COST TRACKER",
        "==============================",
        "Total Cost: $" + session.totalUSD.toFixed(4),
        "Tokens: ",
        "  - Input: " + session.usage.inputTokens,
        "  - Output: " + session.usage.outputTokens,
        "  - Cache Read: " + session.usage.cacheReadTokens,
        "  - Cache Write: " + session.usage.cacheCreationTokens,
        "=============================="
    ].join("\\n");
}
