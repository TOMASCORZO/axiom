'use client';

/**
 * Realtime Studio — manifest-driven observer for a game's multiplayer surface.
 *
 * The UI is entirely derived from `realtime.axiom.json` (the project's realtime
 * manifest). If the manifest declares a chat, the Studio shows a chat viewer;
 * if it declares a rooms/presence/state/events feature, it shows the matching
 * widget. Nothing is hardcoded — an empty manifest yields an empty-state CTA
 * pointing at the agent.
 *
 * This panel is read-only. It subscribes to each declared channel as a silent
 * observer (broadcast.self=false, no track, no send) so devs can see what
 * their players are doing without participating in the traffic.
 *
 * Auth path: /api/database/realtime/dev-token mints a Supabase JWT scoped to
 * the project; RLS on realtime.messages gates channels by `game_id`, so this
 * dev can only observe their own game's traffic.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useEditorStore } from '@/lib/store';
import { RealtimeClient, type RealtimeChannel } from '@supabase/supabase-js';
import {
    Radio,
    Users,
    Wifi,
    WifiOff,
    Loader2,
    AlertTriangle,
    MessageCircle,
    LayoutGrid,
    Activity,
    Gamepad2,
    Sparkles,
} from 'lucide-react';
import {
    type RealtimeManifest,
    type RealtimeFeature,
    type ChatFeature,
    type RoomsFeature,
    type PresenceFeature,
    type StateSyncFeature,
    type EventsFeature,
    type CustomFeature,
    fullTopicFor,
} from '@/lib/realtime/manifest';

// ── Types ─────────────────────────────────────────────────────────

interface ObservedEvent {
    id: string;
    event: string;
    payload: unknown;
    at: string;
}

interface FeatureStream {
    events: ObservedEvent[];
    presence: Record<string, unknown[]>;
    status: 'connecting' | 'subscribed' | 'error' | 'closed';
    error?: string;
}

type StreamMap = Record<string, FeatureStream>;

const EMPTY_STREAM: FeatureStream = { events: [], presence: {}, status: 'connecting' };
const MAX_EVENTS_PER_FEATURE = 100;

// ── Main component ────────────────────────────────────────────────

export default function RealtimeStudio() {
    const setActiveRightPanel = useEditorStore(s => s.setActiveRightPanel);
    const project = useEditorStore(s => s.project);

    const [manifest, setManifest] = useState<RealtimeManifest | null>(null);
    const [manifestError, setManifestError] = useState<string | null>(null);
    const [manifestLoading, setManifestLoading] = useState(true);
    const [parseError, setParseError] = useState<string | null>(null);

    const [streams, setStreams] = useState<StreamMap>({});
    const [connectionError, setConnectionError] = useState<string | null>(null);
    const clientRef = useRef<RealtimeClient | null>(null);
    const channelsRef = useRef<RealtimeChannel[]>([]);

    // ── Load manifest ─────────────────────────────────────────────

    const loadManifest = useCallback(async () => {
        if (!project?.id) return;
        setManifestLoading(true);
        setManifestError(null);
        setParseError(null);
        try {
            const res = await fetch(`/api/projects/${project.id}/realtime/manifest`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? 'Failed to load manifest');
            setManifest(data.manifest ?? null);
            if (data.parse_error) setParseError(data.parse_error);
        } catch (e) {
            setManifestError(e instanceof Error ? e.message : 'Manifest load failed');
        } finally {
            setManifestLoading(false);
        }
    }, [project?.id]);

    useEffect(() => { void loadManifest(); }, [loadManifest]);

    // ── Observer connection ───────────────────────────────────────

    const features = manifest?.features ?? [];
    const featuresKey = useMemo(
        () => features.map(f => `${f.id}:${f.topic}:${f.kind}`).join('|'),
        [features],
    );

    useEffect(() => {
        if (!project?.id || features.length === 0) return;

        let cancelled = false;
        const tearDown = () => {
            for (const ch of channelsRef.current) { void ch.unsubscribe(); }
            channelsRef.current = [];
            if (clientRef.current) {
                clientRef.current.disconnect();
                clientRef.current = null;
            }
        };

        const setFeatureStream = (featureId: string, update: Partial<FeatureStream>) => {
            if (cancelled) return;
            setStreams(prev => ({
                ...prev,
                [featureId]: { ...(prev[featureId] ?? EMPTY_STREAM), ...update },
            }));
        };

        const pushEvent = (featureId: string, ev: ObservedEvent) => {
            if (cancelled) return;
            setStreams(prev => {
                const current = prev[featureId] ?? EMPTY_STREAM;
                return {
                    ...prev,
                    [featureId]: {
                        ...current,
                        events: [ev, ...current.events].slice(0, MAX_EVENTS_PER_FEATURE),
                    },
                };
            });
        };

        (async () => {
            setConnectionError(null);
            // Initialise all features to connecting state.
            setStreams(Object.fromEntries(features.map(f => [f.id, { ...EMPTY_STREAM }])));

            let tokenData: {
                access_token: string;
                supabase_url: string;
                supabase_anon_key: string;
            };
            try {
                const res = await fetch('/api/database/realtime/dev-token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ project_id: project.id }),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error ?? 'Failed to mint dev token');
                tokenData = data;
            } catch (e) {
                if (!cancelled) setConnectionError(e instanceof Error ? e.message : 'Auth failed');
                return;
            }
            if (cancelled) return;

            const wsUrl = `${tokenData.supabase_url.replace(/\/+$/, '').replace(/^http/, 'ws')}/realtime/v1`;
            const rt = new RealtimeClient(wsUrl, {
                params: { apikey: tokenData.supabase_anon_key },
                accessToken: () => Promise.resolve(tokenData.access_token),
            });
            clientRef.current = rt;

            for (const feature of features) {
                if (cancelled) break;
                const fullTopic = fullTopicFor(project.id, feature.topic);
                const ch = rt.channel(fullTopic, {
                    config: {
                        private: true,
                        broadcast: { self: false },
                        presence: { key: `studio-observer:${feature.id}` },
                    },
                });

                ch.on('broadcast', { event: '*' }, ({ event, payload }) => {
                    pushEvent(feature.id, {
                        id: crypto.randomUUID(),
                        event: String(event),
                        payload,
                        at: new Date().toISOString(),
                    });
                });
                ch.on('presence', { event: 'sync' }, () => {
                    setFeatureStream(feature.id, {
                        presence: ch.presenceState() as Record<string, unknown[]>,
                    });
                });
                ch.subscribe(status => {
                    if (status === 'SUBSCRIBED') setFeatureStream(feature.id, { status: 'subscribed' });
                    else if (status === 'CLOSED') setFeatureStream(feature.id, { status: 'closed' });
                    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                        setFeatureStream(feature.id, { status: 'error', error: `Channel ${status.toLowerCase()}` });
                    }
                });
                channelsRef.current.push(ch);
            }
        })();

        return () => {
            cancelled = true;
            tearDown();
        };
        // `features` reference changes by identity every render; gate on a stable key.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [project?.id, featuresKey]);

    // ── Render ────────────────────────────────────────────────────

    const hasFeatures = features.length > 0;

    return (
        <div className="flex flex-col h-full bg-zinc-950">
            <Header
                gameId={project?.id ?? null}
                onBack={() => setActiveRightPanel('chat')}
                onRefresh={loadManifest}
                refreshing={manifestLoading}
            />

            {manifestError && <Banner tone="error">Manifest load error: {manifestError}</Banner>}
            {parseError && <Banner tone="warn">Invalid manifest: {parseError}. The agent can fix it.</Banner>}
            {connectionError && <Banner tone="error">Realtime: {connectionError}</Banner>}

            {manifestLoading && !manifest && (
                <div className="flex-1 flex items-center justify-center">
                    <Loader2 size={18} className="animate-spin text-zinc-600" />
                </div>
            )}

            {!manifestLoading && !hasFeatures && <EmptyState />}

            {hasFeatures && (
                <div className="flex-1 overflow-y-auto">
                    {features.map(feature => (
                        <FeatureCard
                            key={feature.id}
                            feature={feature}
                            stream={streams[feature.id] ?? EMPTY_STREAM}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Header ────────────────────────────────────────────────────────

function Header({
    gameId,
    onBack,
    onRefresh,
    refreshing,
}: {
    gameId: string | null;
    onBack: () => void;
    onRefresh: () => void;
    refreshing: boolean;
}) {
    return (
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
            <div className="flex items-center gap-2 min-w-0">
                <div className="w-5 h-5 rounded bg-gradient-to-br from-fuchsia-500 to-purple-600 flex items-center justify-center flex-shrink-0">
                    <Radio size={10} className="text-white" />
                </div>
                <div className="flex flex-col min-w-0">
                    <span className="text-sm font-semibold text-zinc-200 leading-tight">Realtime</span>
                    {gameId && (
                        <span className="text-[10px] font-mono text-zinc-600 truncate" title={`game:${gameId}`}>
                            game:{gameId.slice(0, 8)}…
                        </span>
                    )}
                </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
                <button
                    onClick={onRefresh}
                    disabled={refreshing}
                    title="Reload manifest"
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 px-2 py-0.5 rounded hover:bg-white/5 transition-colors disabled:opacity-40"
                >
                    {refreshing ? <Loader2 size={10} className="animate-spin" /> : 'Reload'}
                </button>
                <button
                    onClick={onBack}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 px-2 py-0.5 rounded hover:bg-white/5 transition-colors"
                >
                    Close
                </button>
            </div>
        </div>
    );
}

function Banner({ tone, children }: { tone: 'error' | 'warn'; children: React.ReactNode }) {
    const cls = tone === 'error'
        ? 'bg-red-500/10 border-red-500/20 text-red-400'
        : 'bg-amber-500/10 border-amber-500/20 text-amber-300';
    const Icon = tone === 'error' ? AlertTriangle : AlertTriangle;
    return (
        <div className={`mx-3 mt-2 px-3 py-2 rounded border text-[11px] flex items-start gap-2 ${cls}`}>
            <Icon size={12} className="mt-0.5 flex-shrink-0" />
            <div className="min-w-0 break-words">{children}</div>
        </div>
    );
}

// ── Empty state ───────────────────────────────────────────────────

function EmptyState() {
    const suggestions = [
        '«agrégame un chat global»',
        '«haz un lobby de 4 jugadores»',
        '«sincroniza enemigos entre clientes»',
        '«partidas 1v1 con matchmaking»',
    ];
    return (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-8">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-fuchsia-500/20 to-purple-500/10 flex items-center justify-center mb-3">
                <Sparkles size={16} className="text-fuchsia-300" />
            </div>
            <div className="text-sm font-medium text-zinc-300 mb-1">No realtime configured</div>
            <p className="text-xs text-zinc-500 max-w-[260px] mb-4">
                This game hasn&apos;t declared any multiplayer features. Ask the agent and it&apos;ll set it up:
            </p>
            <div className="space-y-1 w-full max-w-[260px]">
                {suggestions.map(s => (
                    <div
                        key={s}
                        className="text-[11px] font-mono text-zinc-400 bg-white/[0.03] border border-white/5 rounded px-2 py-1.5 text-left"
                    >
                        {s}
                    </div>
                ))}
            </div>
        </div>
    );
}

// ── Feature router ────────────────────────────────────────────────

function FeatureCard({ feature, stream }: { feature: RealtimeFeature; stream: FeatureStream }) {
    return (
        <div className="border-b border-white/5">
            <FeatureHeader feature={feature} status={stream.status} statusError={stream.error} />
            <div className="px-3 pb-3">
                {renderFeatureBody(feature, stream)}
            </div>
        </div>
    );
}

function renderFeatureBody(feature: RealtimeFeature, stream: FeatureStream) {
    switch (feature.kind) {
        case 'chat':    return <ChatWidget feature={feature} stream={stream} />;
        case 'rooms':   return <RoomsWidget feature={feature} stream={stream} />;
        case 'presence':return <PresenceWidget feature={feature} stream={stream} />;
        case 'state':   return <StateWidget feature={feature} stream={stream} />;
        case 'events':  return <EventsWidget feature={feature} stream={stream} />;
        case 'custom':  return <CustomWidget feature={feature} stream={stream} />;
    }
}

function FeatureHeader({
    feature,
    status,
    statusError,
}: {
    feature: RealtimeFeature;
    status: FeatureStream['status'];
    statusError?: string;
}) {
    const Icon = ICON_BY_KIND[feature.kind];
    const statusCfg = STATUS_CFG[status];
    return (
        <div className="flex items-start gap-2 px-3 py-2">
            <div className="w-6 h-6 rounded bg-white/5 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Icon size={12} className="text-zinc-400" />
            </div>
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-zinc-200 truncate">{feature.label}</span>
                    <span className="text-[10px] uppercase tracking-wider text-zinc-600">{feature.kind}</span>
                </div>
                {feature.description && (
                    <p className="text-[11px] text-zinc-500 mt-0.5">{feature.description}</p>
                )}
                <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] font-mono text-zinc-600 truncate" title={feature.topic}>
                        {feature.topic}
                    </span>
                    <span className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ${statusCfg.cls}`}>
                        <statusCfg.Icon size={9} className={status === 'connecting' ? 'animate-spin' : ''} />
                        {statusCfg.label}
                    </span>
                </div>
                {statusError && <div className="text-[10px] text-red-400 mt-0.5">{statusError}</div>}
            </div>
        </div>
    );
}

const ICON_BY_KIND: Record<RealtimeFeature['kind'], typeof Radio> = {
    chat: MessageCircle,
    rooms: LayoutGrid,
    presence: Users,
    state: Gamepad2,
    events: Activity,
    custom: Radio,
};

const STATUS_CFG: Record<FeatureStream['status'], { label: string; cls: string; Icon: typeof Wifi }> = {
    connecting: { label: 'connecting', cls: 'text-amber-300 bg-amber-500/10', Icon: Loader2 },
    subscribed: { label: 'live',       cls: 'text-emerald-300 bg-emerald-500/10', Icon: Wifi },
    closed:     { label: 'closed',     cls: 'text-zinc-500 bg-zinc-500/10', Icon: WifiOff },
    error:      { label: 'error',      cls: 'text-red-300 bg-red-500/10', Icon: AlertTriangle },
};

// ── Widgets ───────────────────────────────────────────────────────

function ChatWidget({ feature, stream }: { feature: ChatFeature; stream: FeatureStream }) {
    if (feature.scope === 'room') {
        return (
            <InfoNote>
                Room-scoped chat. Messages appear when players join a room under this topic.
            </InfoNote>
        );
    }
    const messages = stream.events
        .filter(e => e.event === 'message' || e.event === 'chat')
        .slice(0, 30);

    if (messages.length === 0) {
        return <EmptyRow>{stream.status === 'subscribed' ? 'No messages yet.' : 'Waiting for traffic…'}</EmptyRow>;
    }
    return (
        <div className="space-y-1.5">
            {messages.map(m => {
                const p = m.payload as { player_id?: string; text?: string; message?: string } | null;
                const who = p?.player_id ? short(p.player_id) : 'anon';
                const text = p?.text ?? p?.message ?? JSON.stringify(m.payload);
                return (
                    <div key={m.id} className="bg-white/[0.03] rounded px-2 py-1.5">
                        <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[10px] font-mono text-fuchsia-300">{who}</span>
                            <span className="text-[9px] text-zinc-600 ml-auto">{time(m.at)}</span>
                        </div>
                        <div className="text-[11px] text-zinc-300 break-words">{text}</div>
                    </div>
                );
            })}
        </div>
    );
}

function RoomsWidget({ feature, stream }: { feature: RoomsFeature; stream: FeatureStream }) {
    // Rooms aren't persisted (no game_rooms table yet) — we derive live state
    // from room announcement events on the feature's topic.
    const rooms = useMemo(() => {
        const byId = new Map<string, { id: string; meta?: Record<string, unknown>; lastEvent: string; at: string }>();
        for (const e of [...stream.events].reverse()) {
            const p = e.payload as { room_id?: string; id?: string; meta?: Record<string, unknown> } | null;
            const id = p?.room_id ?? p?.id;
            if (!id) continue;
            if (e.event === 'room_closed' || e.event === 'closed') {
                byId.delete(id);
                continue;
            }
            byId.set(id, { id, meta: p?.meta, lastEvent: e.event, at: e.at });
        }
        return Array.from(byId.values()).reverse();
    }, [stream.events]);

    if (rooms.length === 0) {
        return (
            <EmptyRow>
                {stream.status === 'subscribed'
                    ? `No ${feature.roomKind} rooms live.`
                    : 'Waiting for traffic…'}
            </EmptyRow>
        );
    }
    return (
        <div className="space-y-1.5">
            {rooms.map(r => (
                <div key={r.id} className="bg-white/[0.03] rounded px-2 py-1.5">
                    <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[11px] font-mono text-zinc-200 truncate">{r.id}</span>
                        <span className="text-[9px] uppercase text-zinc-600 ml-auto">{r.lastEvent}</span>
                    </div>
                    {r.meta && Object.keys(r.meta).length > 0 && (
                        <div className="space-y-0.5 mt-1">
                            {Object.entries(r.meta).map(([k, v]) => (
                                <div key={k} className="flex items-center gap-2 text-[10px]">
                                    <span className="text-zinc-600 font-mono">{k}</span>
                                    <span className="text-zinc-400 font-mono truncate">{scalarStr(v)}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}

function PresenceWidget({ feature, stream }: { feature: PresenceFeature; stream: FeatureStream }) {
    const entries = Object.entries(stream.presence).flatMap(([key, metas]) =>
        (metas as unknown[]).map((m, i) => ({ key, idx: i, meta: m as Record<string, unknown> })),
    );
    if (entries.length === 0) {
        return <EmptyRow>{stream.status === 'subscribed' ? 'No players online.' : 'Waiting for traffic…'}</EmptyRow>;
    }
    return (
        <div className="space-y-1">
            {entries.map(e => (
                <div key={`${e.key}:${e.idx}`} className="bg-white/[0.03] rounded px-2 py-1.5">
                    <div className="text-[10px] font-mono text-emerald-300 mb-1">{short(e.key)}</div>
                    <div className="space-y-0.5">
                        {feature.fields.map(f => {
                            const v = e.meta?.[f.name];
                            return (
                                <div key={f.name} className="flex items-center gap-2 text-[10px]">
                                    <span className="text-zinc-600 font-mono w-16 truncate" title={f.name}>{f.name}</span>
                                    <span className="text-zinc-300 font-mono truncate">{scalarStr(v)}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
}

function StateWidget({ feature, stream }: { feature: StateSyncFeature; stream: FeatureStream }) {
    const latest = stream.events[0];
    if (!latest) {
        return <EmptyRow>{stream.status === 'subscribed' ? 'No state synced yet.' : 'Waiting for traffic…'}</EmptyRow>;
    }
    const p = (latest.payload ?? {}) as Record<string, unknown>;
    return (
        <div className="bg-white/[0.03] rounded px-2 py-2 space-y-1">
            <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] uppercase text-zinc-600">latest · {latest.event}</span>
                <span className="text-[9px] text-zinc-600">{time(latest.at)}</span>
            </div>
            {feature.fields.map(f => (
                <div key={f.name} className="flex items-start gap-2 text-[10px]">
                    <span className="text-zinc-600 font-mono w-20 truncate" title={f.name}>{f.name}</span>
                    <span className="text-zinc-300 font-mono truncate flex-1">{scalarStr(p[f.name])}</span>
                </div>
            ))}
        </div>
    );
}

function EventsWidget({ feature, stream }: { feature: EventsFeature; stream: FeatureStream }) {
    const declared = new Set(feature.events.map(e => e.name));
    const items = stream.events.filter(e => declared.has(e.event)).slice(0, 30);
    if (items.length === 0) {
        return <EmptyRow>{stream.status === 'subscribed' ? 'No events yet.' : 'Waiting for traffic…'}</EmptyRow>;
    }
    return (
        <div className="space-y-1">
            {items.map(e => {
                const declaredEv = feature.events.find(de => de.name === e.event);
                const p = (e.payload ?? {}) as Record<string, unknown>;
                return (
                    <div key={e.id} className="bg-white/[0.03] rounded px-2 py-1.5">
                        <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[10px] font-mono text-fuchsia-300">{e.event}</span>
                            <span className="text-[9px] text-zinc-600 ml-auto">{time(e.at)}</span>
                        </div>
                        {declaredEv?.fields?.length ? (
                            <div className="space-y-0.5">
                                {declaredEv.fields.map(f => (
                                    <div key={f.name} className="flex items-center gap-2 text-[10px]">
                                        <span className="text-zinc-600 font-mono w-16 truncate">{f.name}</span>
                                        <span className="text-zinc-300 font-mono truncate">{scalarStr(p[f.name])}</span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <pre className="text-[10px] font-mono text-zinc-400 whitespace-pre-wrap break-all">
                                {JSON.stringify(e.payload)}
                            </pre>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function CustomWidget({ feature, stream }: { feature: CustomFeature; stream: FeatureStream }) {
    const items = stream.events.slice(0, 20);
    if (items.length === 0) {
        return (
            <>
                {feature.notes && <InfoNote>{feature.notes}</InfoNote>}
                <EmptyRow>{stream.status === 'subscribed' ? 'No traffic yet.' : 'Waiting for traffic…'}</EmptyRow>
            </>
        );
    }
    return (
        <div className="space-y-1">
            {feature.notes && <InfoNote>{feature.notes}</InfoNote>}
            {items.map(e => (
                <div key={e.id} className="bg-white/[0.03] rounded px-2 py-1.5">
                    <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[10px] font-mono text-zinc-300">{e.event}</span>
                        <span className="text-[9px] text-zinc-600 ml-auto">{time(e.at)}</span>
                    </div>
                    <pre className="text-[10px] font-mono text-zinc-400 whitespace-pre-wrap break-all">
                        {JSON.stringify(e.payload)}
                    </pre>
                </div>
            ))}
        </div>
    );
}

// ── Shared primitives ─────────────────────────────────────────────

function InfoNote({ children }: { children: React.ReactNode }) {
    return (
        <div className="text-[10px] text-zinc-500 bg-white/[0.02] border border-white/5 rounded px-2 py-1.5 mb-1.5">
            {children}
        </div>
    );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
    return <div className="text-[10px] text-zinc-600 italic px-2 py-3 text-center">{children}</div>;
}

function short(s: string): string {
    return s.length > 8 ? `${s.slice(0, 8)}…` : s;
}

function time(iso: string): string {
    return new Date(iso).toLocaleTimeString(undefined, { hour12: false });
}

function scalarStr(v: unknown): string {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}
