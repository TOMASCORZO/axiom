/**
 * PixelLab usage logging + soft rate-limit / budget gate.
 *
 * Every PixelLab-touching server route:
 *   1. Calls `enforcePixellabBudget(userId)` BEFORE submitting work.
 *      Returns {ok:false, reason} if the user is at their hourly cap; the
 *      route should respond 429 with a clear message.
 *   2. Calls `recordPixellabUsage(...)` AFTER the call completes (success or
 *      failure). Failures still count toward rate limits — that prevents a
 *      user from rapid-firing failing prompts to bypass the gate, and it
 *      gives us forensic data when a generation goes weird.
 *
 * All inserts go through the admin client because the service role bypasses
 * RLS — usage rows must be writable from server contexts even when the user's
 * session is unavailable (worker route, agent tool execution).
 */

import { getAdminClient } from '@/lib/supabase/admin';
import { createLogger } from '@/lib/observability/logger';

const log = createLogger('usage-tracking');

export type UsageKind =
    | 'generate_map'
    | 'generate_object'
    | 'generate_iso_tile'
    | 'generate_tileset'
    | 'generate_sprite'
    | 'generate_animation'
    | 'generate_texture'
    | 'remove_background'
    | 'image_to_pixelart';

export type UsageSurface = 'agent' | 'map_studio' | 'asset_studio';

export interface RecordUsageParams {
    userId: string;
    projectId?: string | null;
    kind: UsageKind;
    surface: UsageSurface;
    costUsd: number;
    success: boolean;
    durationMs?: number;
    requestId?: string;
    metadata?: Record<string, unknown>;
}

export async function recordPixellabUsage(p: RecordUsageParams): Promise<void> {
    try {
        const admin = getAdminClient();
        const { error } = await admin.from('pixellab_usage_log').insert({
            user_id: p.userId,
            project_id: p.projectId ?? null,
            kind: p.kind,
            surface: p.surface,
            cost_usd: Number.isFinite(p.costUsd) ? p.costUsd : 0,
            success: p.success,
            duration_ms: p.durationMs ?? null,
            request_id: p.requestId ?? null,
            metadata: p.metadata ?? null,
        });
        if (error) {
            // Don't throw — failing to log usage shouldn't fail the user's
            // generation. But surface it loudly so we notice if the table
            // migration hasn't been run yet.
            log.error('usage_insert_failed', { error: error.message, code: error.code, kind: p.kind });
        }
    } catch (err) {
        log.error('usage_insert_threw', {
            error: err instanceof Error ? err.message : String(err),
            kind: p.kind,
        });
    }
}

export interface UsageWindowResult {
    callCount: number;
    totalCostUsd: number;
}

/** Reads usage for the given user over the last N hours via the SECURITY
 *  DEFINER function defined in setup.sql. Returns zeros if the function is
 *  missing (migration not yet applied) so the call doesn't hard-fail. */
export async function getUserUsageWindow(userId: string, windowHours = 1): Promise<UsageWindowResult> {
    try {
        const admin = getAdminClient();
        const { data, error } = await admin.rpc('pixellab_usage_window', {
            p_user_id: userId,
            p_window_hours: windowHours,
        });
        if (error) {
            log.warn('usage_window_rpc_failed', { error: error.message, code: error.code });
            return { callCount: 0, totalCostUsd: 0 };
        }
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) return { callCount: 0, totalCostUsd: 0 };
        return {
            callCount: Number(row.call_count ?? 0),
            totalCostUsd: Number(row.total_cost_usd ?? 0),
        };
    } catch (err) {
        log.warn('usage_window_threw', { error: err instanceof Error ? err.message : String(err) });
        return { callCount: 0, totalCostUsd: 0 };
    }
}

export interface BudgetGateResult {
    ok: boolean;
    reason?: string;
    callCount: number;
    totalCostUsd: number;
    callLimit: number;
    budgetLimitUsd: number;
}

/** Hourly soft cap. Reads from env so ops can tune without redeploys.
 *  Defaults are conservative — bump after watching real usage. */
function readLimits(): { callLimit: number; budgetLimitUsd: number } {
    const callLimit = Number(process.env.PIXELLAB_RATE_LIMIT_HOUR ?? 30);
    const budgetLimitUsd = Number(process.env.PIXELLAB_BUDGET_USD_HOUR ?? 5);
    return {
        callLimit: Number.isFinite(callLimit) && callLimit > 0 ? callLimit : 30,
        budgetLimitUsd: Number.isFinite(budgetLimitUsd) && budgetLimitUsd > 0 ? budgetLimitUsd : 5,
    };
}

/**
 * Pre-flight gate. Call before submitting work to PixelLab.
 *   - ok=false → respond 429 with `reason` to the client.
 *   - ok=true  → proceed; remember to call recordPixellabUsage afterwards.
 *
 * Bypass entirely by setting `PIXELLAB_RATE_LIMIT_DISABLED=1` (useful for
 * local dev or when running internal evals).
 */
export async function enforcePixellabBudget(userId: string): Promise<BudgetGateResult> {
    const { callLimit, budgetLimitUsd } = readLimits();

    if (process.env.PIXELLAB_RATE_LIMIT_DISABLED === '1') {
        return { ok: true, callCount: 0, totalCostUsd: 0, callLimit, budgetLimitUsd };
    }

    const { callCount, totalCostUsd } = await getUserUsageWindow(userId, 1);

    if (callCount >= callLimit) {
        return {
            ok: false,
            reason: `Rate limit: ${callCount}/${callLimit} PixelLab calls in the last hour. Try again later.`,
            callCount, totalCostUsd, callLimit, budgetLimitUsd,
        };
    }
    if (totalCostUsd >= budgetLimitUsd) {
        return {
            ok: false,
            reason: `Hourly budget reached: $${totalCostUsd.toFixed(2)} of $${budgetLimitUsd.toFixed(2)} spent in the last hour.`,
            callCount, totalCostUsd, callLimit, budgetLimitUsd,
        };
    }
    return { ok: true, callCount, totalCostUsd, callLimit, budgetLimitUsd };
}
