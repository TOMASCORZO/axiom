/**
 * Axiom Runtime SDK — browser/WASM client for games hosted on Axiom.
 *
 * Drop-in usage from a game runtime:
 *
 *   import { createAxiomClient } from 'https://your-axiom-host/sdk/axiom.js';
 *
 *   const axiom = createAxiomClient({
 *       baseUrl: 'https://your-axiom-host',
 *       gameId:  '<project uuid>',
 *   });
 *
 *   // Anonymous play:
 *   await axiom.auth.signInAnonymously();
 *
 *   // Google sign-in (full-page redirect, comes back via URL fragment):
 *   axiom.auth.signInWithGoogle({ redirectTo: window.location.href });
 *   // ...on the page that handles the redirect:
 *   axiom.auth.handleOAuthRedirect();
 *
 *   // DB ops (Supabase-flavored):
 *   const { rows } = await axiom.from('saves').scope('player').select();
 *   await axiom.from('high_scores').scope('public').insert({ score: 1234 });
 *
 *   // Realtime (broadcast + presence, auto-scoped to this game):
 *   const lobby = await axiom.channel('lobby');
 *   lobby.on('chat', msg => console.log(msg));
 *   lobby.subscribe(status => console.log('lobby', status));
 *   await lobby.broadcast('chat', { text: 'gg' });
 *
 *   // CDC (table change subscriptions — every insert/update/delete done via
 *   // axiom.from(...).insert/update/delete fans out to subscribers here):
 *   const sub = await axiom.from('messages')
 *       .on('INSERT', ({ row }) => console.log('new msg', row))
 *       .on('UPDATE', ({ row }) => console.log('edited',  row))
 *       .on('DELETE', ({ row }) => console.log('deleted', row))
 *       .subscribe();
 *   // ...later:
 *   await sub.unsubscribe();
 *
 * No build step. Single file. Works in any browser that supports fetch +
 * localStorage + URLSearchParams. The SDK is intentionally thin — server-side
 * is where the real validation happens; this file only stores tokens, builds
 * request bodies, and exposes a chainable query builder.
 */

const TOKEN_STORAGE_PREFIX = 'axiom.session.';
const REALTIME_CDN = 'https://esm.sh/@supabase/realtime-js@2';
const REALTIME_REFRESH_BUFFER_MS = 30_000; // refresh 30s before expiry

function tokenStorageKey(gameId) {
    return `${TOKEN_STORAGE_PREFIX}${gameId}`;
}

function readSession(gameId) {
    try {
        const raw = localStorage.getItem(tokenStorageKey(gameId));
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function writeSession(gameId, session) {
    try {
        if (session === null) localStorage.removeItem(tokenStorageKey(gameId));
        else localStorage.setItem(tokenStorageKey(gameId), JSON.stringify(session));
    } catch {
        // localStorage may be unavailable (private mode, server-side render).
        // Callers can still pass tokens explicitly via setSession.
    }
}

class AxiomError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'AxiomError';
        this.status = status ?? 0;
    }
}

async function parseError(res) {
    let message = `HTTP ${res.status}`;
    try {
        const body = await res.json();
        if (body && typeof body.error === 'string') message = body.error;
    } catch {
        // non-JSON error body — keep the HTTP code
    }
    return new AxiomError(message, res.status);
}

function createAuth(state) {
    return {
        getSession() {
            return state.session ? { ...state.session } : null;
        },

        setSession(session) {
            state.session = session;
            writeSession(state.gameId, session);
        },

        signOut() {
            state.session = null;
            writeSession(state.gameId, null);
        },

        async signInAnonymously() {
            const res = await fetch(`${state.baseUrl}/api/runtime/auth/anonymous`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ game_id: state.gameId }),
            });
            if (!res.ok) throw await parseError(res);
            const body = await res.json();
            const session = {
                access_token: body.access_token,
                player_id: body.player_id,
                provider: body.provider,
            };
            this.setSession(session);
            return session;
        },

        // Full-page redirect to Google. Pass the URL the OAuth callback should
        // bounce the player back to (typically the current page).
        signInWithGoogle({ redirectTo } = {}) {
            const target = redirectTo ?? (typeof window !== 'undefined' ? window.location.href : null);
            if (!target) throw new AxiomError('redirectTo is required outside a browser context', 0);
            const url = new URL(`${state.baseUrl}/api/runtime/auth/oauth/google`);
            url.searchParams.set('game_id', state.gameId);
            url.searchParams.set('redirect_to', target);
            window.location.assign(url.toString());
        },

        // Read access_token / player_id / provider from the URL fragment (set
        // by the OAuth callback). Stores the session and clears the fragment.
        // Returns the session, or null if there was nothing to handle.
        handleOAuthRedirect() {
            if (typeof window === 'undefined') return null;
            const hash = window.location.hash.startsWith('#')
                ? window.location.hash.slice(1)
                : window.location.hash;
            if (!hash) return null;
            const params = new URLSearchParams(hash);
            const error = params.get('error');
            if (error) {
                history.replaceState(null, '', window.location.pathname + window.location.search);
                throw new AxiomError(error, 0);
            }
            const access_token = params.get('access_token');
            const player_id = params.get('player_id');
            const provider = params.get('provider');
            if (!access_token || !player_id) return null;
            const session = { access_token, player_id, provider: provider ?? 'unknown' };
            this.setSession(session);
            history.replaceState(null, '', window.location.pathname + window.location.search);
            return session;
        },

        // Verifies the cached token against /me and returns the player record,
        // or null if the token is missing/invalid (clears storage in that case).
        async me() {
            if (!state.session) return null;
            const res = await fetch(`${state.baseUrl}/api/runtime/auth/me`, {
                headers: { Authorization: `Bearer ${state.session.access_token}` },
            });
            if (res.status === 401) {
                this.signOut();
                return null;
            }
            if (!res.ok) throw await parseError(res);
            return await res.json();
        },
    };
}

class QueryBuilder {
    constructor(state, table, realtime) {
        this._state = state;
        this._realtime = realtime;
        this._table = table;
        this._req = {
            table,
            scope: 'player',
            filters: [],
            order: [],
        };
        // Becomes non-null the first time .on(...) is called; .subscribe()
        // switches on this to pick CDC mode vs. the existing channel API.
        this._cdc = null;
    }

    scope(scope) {
        if (scope !== 'player' && scope !== 'public') {
            throw new AxiomError(`scope must be "player" or "public" (got ${scope})`, 0);
        }
        this._req.scope = scope;
        return this;
    }

    eq(column, value)   { this._req.filters.push({ column, op: '=',  value }); return this; }
    neq(column, value)  { this._req.filters.push({ column, op: '!=', value }); return this; }
    gt(column, value)   { this._req.filters.push({ column, op: '>',  value }); return this; }
    gte(column, value)  { this._req.filters.push({ column, op: '>=', value }); return this; }
    lt(column, value)   { this._req.filters.push({ column, op: '<',  value }); return this; }
    lte(column, value)  { this._req.filters.push({ column, op: '<=', value }); return this; }
    like(column, value) { this._req.filters.push({ column, op: 'like', value }); return this; }
    in(column, values)  { this._req.filters.push({ column, op: 'in', value: values }); return this; }

    order(column, { ascending = true } = {}) {
        this._req.order.push({ column, ascending });
        return this;
    }

    limit(n)  { this._req.limit  = n; return this; }
    offset(n) { this._req.offset = n; return this; }

    select(columns) {
        const cols = columns
            ? (Array.isArray(columns) ? columns : String(columns).split(',').map(s => s.trim()))
            : undefined;
        return this._send('select', { columns: cols });
    }

    insert(values) {
        return this._send('insert', { values });
    }

    update(set) {
        return this._send('update', { set });
    }

    delete() {
        return this._send('delete', {});
    }

    // Switch this builder into CDC-subscription mode. Accepts 'INSERT',
    // 'UPDATE', 'DELETE', or '*' (all three). Multiple calls accumulate.
    // Handlers receive `{ op, table, row }`.
    on(event, handler) {
        if (typeof handler !== 'function') {
            throw new AxiomError('on(event, handler) requires a function', 0);
        }
        const key = String(event).toUpperCase();
        if (key !== 'INSERT' && key !== 'UPDATE' && key !== 'DELETE' && key !== '*') {
            throw new AxiomError(`on: event must be INSERT | UPDATE | DELETE | * (got ${event})`, 0);
        }
        if (!this._cdc) this._cdc = { handlers: [] };
        this._cdc.handlers.push({ event: key, handler });
        return this;
    }

    // In CDC mode, .subscribe() opens a realtime channel on
    // `game:<gameId>:db:<table>` and wires each .on() handler. Returns an
    // object with `.unsubscribe()`. Must be awaited.
    async subscribe(statusCallback) {
        if (!this._cdc) {
            throw new AxiomError('.subscribe() requires at least one .on(event, handler) call', 0);
        }
        const handlers = this._cdc.handlers;
        const channel = await this._realtime.channel(`db:${this._table}`);
        for (const { event, handler } of handlers) {
            if (event === '*') {
                channel.on('INSERT', handler);
                channel.on('UPDATE', handler);
                channel.on('DELETE', handler);
            } else {
                channel.on(event, handler);
            }
        }
        channel.subscribe(statusCallback);
        return {
            table: this._table,
            topic: channel.topic,
            _ch: channel,
            unsubscribe: () => channel.unsubscribe(),
        };
    }

    async _send(op, extra) {
        const session = this._state.session;
        if (!session) throw new AxiomError('Not authenticated — call axiom.auth.signInAnonymously() first', 401);

        const body = { ...this._req, op, ...extra };
        if (body.filters.length === 0) delete body.filters;
        if (body.order.length === 0)   delete body.order;

        const res = await fetch(`${this._state.baseUrl}/api/runtime/db`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify(body),
        });
        if (res.status === 401) {
            // Token is dead — clear it so the next call forces a re-auth.
            writeSession(this._state.gameId, null);
            this._state.session = null;
        }
        if (!res.ok) throw await parseError(res);
        return await res.json();
    }
}

/**
 * Realtime: thin wrapper around @supabase/realtime-js that auto-prefixes
 * channel topics with `game:<gameId>:` and keeps the Supabase JWT fresh.
 *
 * Channel access is gated server-side by RLS on realtime.messages — the JWT
 * minted by /api/runtime/realtime/token carries `game_id`, and the policy
 * only allows topics that match `game:<jwt.game_id>:%`. So even if a player
 * tampers with the topic name, they can't peek into another game's traffic.
 *
 * The realtime client is lazy-loaded from a CDN (esm.sh) on first use so
 * games that never call .channel() don't pay the bytes.
 */
function createRealtime(state) {
    let clientPromise = null;          // Promise<RealtimeClient>
    let refreshTimer = null;
    let config = null;                 // { access_token, expires_at, channel_prefix, supabase_url, anon_key }

    async function mintToken() {
        const session = state.session;
        if (!session) throw new AxiomError('Not authenticated — call axiom.auth.signInAnonymously() first', 401);
        const res = await fetch(`${state.baseUrl}/api/runtime/realtime/token`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!res.ok) throw await parseError(res);
        const body = await res.json();
        config = {
            access_token: body.access_token,
            expires_at: Date.now() + body.expires_in * 1000,
            channel_prefix: body.channel_prefix,
            supabase_url: body.supabase_url,
            anon_key: body.supabase_anon_key,
        };
        return config;
    }

    function scheduleRefresh(client) {
        if (refreshTimer) clearTimeout(refreshTimer);
        if (!config) return;
        const delay = Math.max(1000, config.expires_at - Date.now() - REALTIME_REFRESH_BUFFER_MS);
        refreshTimer = setTimeout(async () => {
            try {
                await mintToken();
                client.setAuth(config.access_token);
                scheduleRefresh(client);
            } catch (err) {
                // Token refresh runs in the background — log instead of throwing
                // across event loops. Player-side reconnect logic will retry.
                console.warn('[axiom realtime] token refresh failed:', err);
            }
        }, delay);
    }

    async function getClient() {
        if (clientPromise) return clientPromise;
        clientPromise = (async () => {
            await mintToken();
            const mod = await import(/* @vite-ignore */ REALTIME_CDN);
            const RealtimeClient = mod.RealtimeClient ?? mod.default?.RealtimeClient;
            if (!RealtimeClient) {
                throw new AxiomError('Failed to load @supabase/realtime-js from CDN', 0);
            }
            const wsUrl = `${config.supabase_url.replace(/\/+$/, '').replace(/^http/, 'ws')}/realtime/v1`;
            const client = new RealtimeClient(wsUrl, {
                params: { apikey: config.anon_key },
                accessToken: () => Promise.resolve(config?.access_token),
            });
            scheduleRefresh(client);
            return client;
        })();
        return clientPromise;
    }

    return {
        // axiom.channel('lobby') → joins `game:<gid>:lobby` as a private channel
        async channel(topic, opts = {}) {
            if (!topic || typeof topic !== 'string') {
                throw new AxiomError('channel(topic) requires a non-empty string', 0);
            }
            const client = await getClient();
            const fullTopic = `${config.channel_prefix}${topic}`;
            const channel = client.channel(fullTopic, {
                config: {
                    private: true,
                    broadcast: { self: opts.receiveOwn ?? false, ack: opts.ack ?? false },
                    presence: { key: opts.presenceKey ?? state.session?.player_id ?? '' },
                },
            });

            return {
                topic: fullTopic,
                _ch: channel,

                on(event, handler) {
                    channel.on('broadcast', { event }, ({ payload }) => handler(payload));
                    return this;
                },

                onPresence(event, handler) {
                    // event: 'sync' | 'join' | 'leave'
                    channel.on('presence', { event }, payload => handler(payload));
                    return this;
                },

                async broadcast(event, payload) {
                    return await channel.send({ type: 'broadcast', event, payload });
                },

                async track(state) {
                    return await channel.track(state);
                },

                async untrack() {
                    return await channel.untrack();
                },

                presenceState() {
                    return channel.presenceState();
                },

                subscribe(callback) {
                    channel.subscribe(status => callback?.(status));
                    return this;
                },

                async unsubscribe() {
                    return await channel.unsubscribe();
                },
            };
        },

        // For tests / advanced consumers who want to drop the underlying socket.
        async disconnect() {
            if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
            if (clientPromise) {
                const client = await clientPromise;
                client.disconnect();
                clientPromise = null;
            }
            config = null;
        },
    };
}

export function createAxiomClient(options) {
    if (!options || typeof options !== 'object') {
        throw new AxiomError('createAxiomClient: options object is required', 0);
    }
    const { baseUrl, gameId } = options;
    if (!baseUrl) throw new AxiomError('createAxiomClient: baseUrl is required', 0);
    if (!gameId)  throw new AxiomError('createAxiomClient: gameId is required',  0);

    const state = {
        baseUrl: baseUrl.replace(/\/+$/, ''),
        gameId,
        session: readSession(gameId),
    };

    const realtime = createRealtime(state);

    const client = {
        get gameId() { return state.gameId; },
        get baseUrl() { return state.baseUrl; },
        from(table) {
            if (!table || typeof table !== 'string') {
                throw new AxiomError('from(table) requires a non-empty string', 0);
            }
            return new QueryBuilder(state, table, realtime);
        },
        channel(topic, opts) { return realtime.channel(topic, opts); },
        disconnect() { return realtime.disconnect(); },
    };
    client.auth = createAuth(state);
    return client;
}

export { AxiomError };

// Browser-global fallback so non-module consumers (e.g., Godot HTML5
// JavaScript bridge calls) can `window.Axiom.createClient(...)`.
if (typeof window !== 'undefined') {
    window.Axiom = window.Axiom || {};
    window.Axiom.createClient = createAxiomClient;
    window.Axiom.AxiomError = AxiomError;
}
