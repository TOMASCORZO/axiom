'use client';

/**
 * Realtime Studio — standalone right-panel for debugging game-scoped
 * Supabase Realtime channels.
 *
 * Auth path: /api/database/realtime/dev-token mints a Supabase JWT scoped to
 * the project (using the dev's owner cookie), so the dev can subscribe as
 * themselves without faking a player session. RLS on realtime.messages still
 * gates by `game_id`, so devs only see channels for projects they own.
 *
 * The actual UI mirrors what a player runtime gets through axiom.channel():
 * a topic input (auto-prefixed with `game:<project_id>:`), a sent/received
 * message stream, broadcast composer, and presence tracker.
 */

import { useState, useCallback, useEffect } from 'react';
import { useEditorStore } from '@/lib/store';
import { RealtimeClient, type RealtimeChannel } from '@supabase/supabase-js';
import {
    Radio,
    Send,
    Users,
    Wifi,
    WifiOff,
    Loader2,
    AlertTriangle,
} from 'lucide-react';

interface RealtimeMessage {
    id: string;
    direction: 'sent' | 'received';
    event: string;
    payload: unknown;
    at: string;
}

type ConnectionStatus = 'idle' | 'connecting' | 'subscribed' | 'closed' | 'error';

export default function RealtimeStudio() {
    const setActiveRightPanel = useEditorStore(s => s.setActiveRightPanel);
    const project = useEditorStore(s => s.project);

    const [topic, setTopic] = useState('lobby');
    const [activeTopic, setActiveTopic] = useState<string | null>(null);
    const [status, setStatus] = useState<ConnectionStatus>('idle');
    const [error, setError] = useState<string | null>(null);
    const [messages, setMessages] = useState<RealtimeMessage[]>([]);
    const [presence, setPresence] = useState<Record<string, unknown[]>>({});
    const [eventName, setEventName] = useState('chat');
    const [payloadText, setPayloadText] = useState('{"text": "hello"}');
    const [trackText, setTrackText] = useState('{"online_at": "now"}');
    const [client, setClient] = useState<RealtimeClient | null>(null);
    const [channel, setChannel] = useState<RealtimeChannel | null>(null);

    const log = useCallback((m: Omit<RealtimeMessage, 'id' | 'at'>) => {
        setMessages(prev => [
            { id: crypto.randomUUID(), at: new Date().toISOString(), ...m },
            ...prev,
        ].slice(0, 200));
    }, []);

    const disconnect = useCallback(async () => {
        if (channel) await channel.unsubscribe();
        if (client) client.disconnect();
        setChannel(null);
        setClient(null);
        setStatus('closed');
        setActiveTopic(null);
        setPresence({});
    }, [channel, client]);

    const connect = useCallback(async () => {
        if (!project?.id) return;
        await disconnect();
        setError(null);
        setStatus('connecting');
        setMessages([]);
        try {
            const res = await fetch('/api/database/realtime/dev-token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ project_id: project.id }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? 'Failed to mint dev token');

            const wsUrl = `${data.supabase_url.replace(/\/+$/, '').replace(/^http/, 'ws')}/realtime/v1`;
            const fullTopic = `${data.channel_prefix}${topic}`;
            const rt = new RealtimeClient(wsUrl, {
                params: { apikey: data.supabase_anon_key },
                accessToken: () => Promise.resolve(data.access_token),
            });
            const ch = rt.channel(fullTopic, {
                config: {
                    private: true,
                    broadcast: { self: false },
                    presence: { key: 'studio-dev' },
                },
            });
            ch.on('broadcast', { event: '*' }, ({ event, payload }) => {
                log({ direction: 'received', event: String(event), payload });
            });
            ch.on('presence', { event: 'sync' }, () => {
                setPresence(ch.presenceState() as Record<string, unknown[]>);
            });
            ch.subscribe(s => {
                if (s === 'SUBSCRIBED') { setStatus('subscribed'); setActiveTopic(fullTopic); }
                else if (s === 'CLOSED') setStatus('closed');
                else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') {
                    setStatus('error');
                    setError(`Channel error: ${s}`);
                }
            });
            setClient(rt);
            setChannel(ch);
        } catch (e) {
            setStatus('error');
            setError(e instanceof Error ? e.message : 'Connection failed');
        }
    }, [project?.id, topic, disconnect, log]);

    useEffect(() => {
        return () => {
            if (channel) void channel.unsubscribe();
            if (client) client.disconnect();
        };
    }, [channel, client]);

    const sendBroadcast = async () => {
        if (!channel || status !== 'subscribed') return;
        let payload: unknown = payloadText;
        try { payload = JSON.parse(payloadText); } catch { /* send as raw string */ }
        try {
            await channel.send({ type: 'broadcast', event: eventName, payload });
            log({ direction: 'sent', event: eventName, payload });
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Broadcast failed');
        }
    };

    const trackPresence = async () => {
        if (!channel || status !== 'subscribed') return;
        let state: Record<string, unknown> = {};
        try { state = JSON.parse(trackText); } catch {
            setError('Presence state must be valid JSON');
            return;
        }
        try {
            await channel.track(state);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Track failed');
        }
    };

    const presenceList = Object.entries(presence).flatMap(([key, metas]) =>
        metas.map((m, i) => ({ key, idx: i, meta: m })),
    );

    const StatusBadge = () => {
        const cfg: Record<ConnectionStatus, { label: string; cls: string; Icon: typeof Wifi }> = {
            idle:        { label: 'Not connected',  cls: 'text-zinc-500 bg-zinc-500/10', Icon: WifiOff },
            connecting:  { label: 'Connecting…',    cls: 'text-amber-300 bg-amber-500/10', Icon: Loader2 },
            subscribed:  { label: 'Subscribed',     cls: 'text-emerald-300 bg-emerald-500/10', Icon: Wifi },
            closed:      { label: 'Closed',         cls: 'text-zinc-500 bg-zinc-500/10', Icon: WifiOff },
            error:       { label: 'Error',          cls: 'text-red-300 bg-red-500/10', Icon: AlertTriangle },
        };
        const { label, cls, Icon } = cfg[status];
        return (
            <span className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ${cls}`}>
                <Icon size={10} className={status === 'connecting' ? 'animate-spin' : ''} />
                {label}
            </span>
        );
    };

    return (
        <div className="flex flex-col h-full bg-zinc-950">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded bg-gradient-to-br from-fuchsia-500 to-purple-600 flex items-center justify-center">
                        <Radio size={10} className="text-white" />
                    </div>
                    <span className="text-sm font-semibold text-zinc-200">Realtime Studio</span>
                </div>
                <button
                    onClick={() => setActiveRightPanel('chat')}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 px-2 py-0.5 rounded hover:bg-white/5 transition-colors"
                >
                    Back to Chat
                </button>
            </div>

            {/* Connect bar */}
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-white/5">
                <span className="text-[10px] font-mono text-zinc-600 flex-shrink-0" title={`game:${project?.id ?? ''}:`}>game:</span>
                <input
                    value={topic}
                    onChange={e => setTopic(e.target.value)}
                    disabled={status === 'subscribed' || status === 'connecting'}
                    placeholder="topic"
                    className="flex-1 min-w-0 bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs font-mono text-zinc-200 focus:outline-none focus:border-fuchsia-500/50 disabled:opacity-50"
                />
                {status === 'subscribed' || status === 'connecting' ? (
                    <button
                        onClick={disconnect}
                        className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors"
                    >
                        <WifiOff size={10} /> Disconnect
                    </button>
                ) : (
                    <button
                        onClick={connect}
                        disabled={!project?.id || !topic.trim()}
                        className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-fuchsia-500/15 text-fuchsia-300 hover:bg-fuchsia-500/25 disabled:opacity-30 transition-colors"
                    >
                        <Wifi size={10} /> Connect
                    </button>
                )}
                <StatusBadge />
            </div>

            {error && (
                <div className="m-3 px-3 py-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
                    {error}
                </div>
            )}

            {status === 'idle' && !error && (
                <div className="flex-1 flex items-center justify-center text-center px-6">
                    <div className="max-w-sm text-zinc-500 text-xs space-y-2">
                        <Radio size={28} className="mx-auto text-zinc-700" />
                        <p>Subscribe to a channel to debug realtime traffic for this game.</p>
                        <p className="text-zinc-600">
                            Players connect via{' '}
                            <span className="font-mono text-zinc-400">axiom.channel(&apos;{topic || 'topic'}&apos;)</span>;
                            the actual subscription is gated by the RLS policy on{' '}
                            <span className="font-mono text-zinc-400">realtime.messages</span> to{' '}
                            <span className="font-mono text-zinc-400">game:{'<id>'}:%</span>.
                        </p>
                    </div>
                </div>
            )}

            {(status !== 'idle') && (
                <div className="flex-1 flex flex-col overflow-hidden">
                    {/* Messages stream */}
                    <div className="flex flex-col overflow-hidden flex-1 min-h-0">
                        <div className="px-3 py-1.5 border-b border-white/5 flex items-center justify-between">
                            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                                Messages · {messages.length}
                            </span>
                            <button
                                onClick={() => setMessages([])}
                                className="text-[10px] text-zinc-500 hover:text-zinc-300"
                            >
                                Clear
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto">
                            {messages.length === 0 && (
                                <div className="px-3 py-6 text-xs text-center text-zinc-600">
                                    {status === 'subscribed' ? 'No messages yet.' : 'Channel not subscribed.'}
                                </div>
                            )}
                            {messages.map(m => (
                                <div key={m.id} className="px-3 py-2 border-b border-white/5 hover:bg-white/[0.02]">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className={`text-[10px] uppercase px-1.5 rounded font-mono ${
                                            m.direction === 'sent'
                                                ? 'bg-fuchsia-500/10 text-fuchsia-300'
                                                : 'bg-emerald-500/10 text-emerald-300'
                                        }`}>{m.direction}</span>
                                        <span className="text-[11px] font-mono text-zinc-300">{m.event}</span>
                                        <span className="text-[10px] text-zinc-700 font-mono ml-auto">
                                            {new Date(m.at).toLocaleTimeString()}
                                        </span>
                                    </div>
                                    <pre className="text-[11px] font-mono text-zinc-400 whitespace-pre-wrap break-all">
                                        {typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload, null, 2)}
                                    </pre>
                                </div>
                            ))}
                        </div>

                        {/* Broadcast composer */}
                        <div className="border-t border-white/5 p-2 flex items-center gap-1.5">
                            <input
                                value={eventName}
                                onChange={e => setEventName(e.target.value)}
                                placeholder="event"
                                disabled={status !== 'subscribed'}
                                className="w-20 flex-shrink-0 bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs font-mono text-zinc-200 focus:outline-none focus:border-fuchsia-500/50 disabled:opacity-50"
                            />
                            <input
                                value={payloadText}
                                onChange={e => setPayloadText(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') sendBroadcast(); }}
                                placeholder="payload (JSON)"
                                disabled={status !== 'subscribed'}
                                className="flex-1 min-w-0 bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs font-mono text-zinc-200 focus:outline-none focus:border-fuchsia-500/50 disabled:opacity-50"
                            />
                            <button
                                onClick={sendBroadcast}
                                disabled={status !== 'subscribed' || !eventName.trim()}
                                title="Broadcast"
                                className="flex-shrink-0 flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-fuchsia-500/15 text-fuchsia-300 hover:bg-fuchsia-500/25 disabled:opacity-30"
                            >
                                <Send size={10} />
                            </button>
                        </div>
                    </div>

                    {/* Presence panel */}
                    <div className="flex flex-col overflow-hidden border-t border-white/10 max-h-[40%]">
                        <div className="px-3 py-1.5 border-b border-white/5 flex items-center gap-2">
                            <Users size={11} className="text-zinc-500" />
                            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                                Presence · {presenceList.length}
                            </span>
                        </div>
                        <div className="flex-1 overflow-y-auto">
                            {presenceList.length === 0 && (
                                <div className="px-3 py-6 text-xs text-center text-zinc-600">
                                    No presence yet. Track a state below.
                                </div>
                            )}
                            {presenceList.map(p => (
                                <div key={`${p.key}:${p.idx}`} className="px-3 py-2 border-b border-white/5">
                                    <div className="text-[10px] font-mono text-zinc-400 mb-1">{p.key}</div>
                                    <pre className="text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-all">
                                        {JSON.stringify(p.meta, null, 2)}
                                    </pre>
                                </div>
                            ))}
                        </div>
                        <div className="border-t border-white/5 p-2 space-y-2">
                            <textarea
                                value={trackText}
                                onChange={e => setTrackText(e.target.value)}
                                placeholder="presence state (JSON)"
                                disabled={status !== 'subscribed'}
                                rows={2}
                                className="w-full bg-zinc-900 border border-white/10 rounded px-2 py-1 text-xs font-mono text-zinc-200 resize-none focus:outline-none focus:border-fuchsia-500/50 disabled:opacity-50"
                            />
                            <button
                                onClick={trackPresence}
                                disabled={status !== 'subscribed'}
                                className="w-full text-[10px] px-2 py-1 rounded bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-30"
                            >
                                Track presence
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {activeTopic && status === 'subscribed' && (
                <div className="px-3 py-1 border-t border-white/5 text-[10px] font-mono text-zinc-600 truncate">
                    {activeTopic}
                </div>
            )}
        </div>
    );
}
