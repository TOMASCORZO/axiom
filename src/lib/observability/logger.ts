/**
 * Structured server-side logger.
 *
 * One JSON line per event so log aggregators (Vercel, Datadog, Sentry breadcrumbs)
 * can parse without regex. Avoids `console.error('[map-action] err:', e)` style
 * prints that lose context and can't be filtered.
 *
 * Usage:
 *   const log = createLogger('map-action', { userId, projectId, requestId });
 *   log.info('generate_object.start', { prompt, tile_size });
 *   log.error('generate_object.failed', { error: msg });
 *
 * Each event ships: ts, level, route, msg, requestId, userId, projectId, ...extra.
 * In dev (non-prod) we pretty-print to stderr; in prod we emit one-line JSON.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
    userId?: string | null;
    projectId?: string | null;
    requestId?: string | null;
    [k: string]: unknown;
}

export interface Logger {
    debug: (msg: string, extra?: Record<string, unknown>) => void;
    info: (msg: string, extra?: Record<string, unknown>) => void;
    warn: (msg: string, extra?: Record<string, unknown>) => void;
    error: (msg: string, extra?: Record<string, unknown>) => void;
    child: (extra: LogContext) => Logger;
}

const isProd = process.env.NODE_ENV === 'production';

function emit(route: string, level: LogLevel, base: LogContext, msg: string, extra?: Record<string, unknown>) {
    const event = {
        ts: new Date().toISOString(),
        level,
        route,
        msg,
        ...base,
        ...(extra ?? {}),
    };
    const line = isProd ? JSON.stringify(event) : `[${level}] ${route} · ${msg} ${JSON.stringify({ ...base, ...(extra ?? {}) })}`;
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
}

export function createLogger(route: string, ctx: LogContext = {}): Logger {
    const make = (base: LogContext): Logger => ({
        debug: (msg, extra) => emit(route, 'debug', base, msg, extra),
        info: (msg, extra) => emit(route, 'info', base, msg, extra),
        warn: (msg, extra) => emit(route, 'warn', base, msg, extra),
        error: (msg, extra) => emit(route, 'error', base, msg, extra),
        child: (more) => make({ ...base, ...more }),
    });
    return make(ctx);
}

/** Generates a short opaque request id for correlating logs + downstream calls. */
export function newRequestId(): string {
    // 12 hex chars is enough at our volumes; full UUIDs are noisy in logs.
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}
