'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { useEditorStore } from '@/lib/store';
import { checkEngineAvailability, type EngineAvailability } from '@/lib/engine/loader';
import { engineBridge } from '@/lib/engine/bridge';
import { translateProjectFiles, translateEngineMessage } from '@/lib/engine/translate';
import { Loader2, Zap } from 'lucide-react';
import GizmoToolbar from './GizmoToolbar';

// Chunked conversion — a single `btoa(String.fromCharCode(...arr))` blows the
// call-stack on multi-MB PNGs. 32 KB is well under the argument-count limit.
function arrayBufferToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return btoa(binary);
}

/**
 * Animated canvas fallback — shown when WASM engine is not compiled.
 * Has all the same visual fidelity as before: grid, crosshair, particles when playing.
 */
function FallbackCanvas({ isPlaying }: { isPlaying: boolean }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const animFrameRef = useRef<number>(0);
    const lastTimeRef = useRef<number>(0);
    const fpsHistoryRef = useRef<number[]>([]);
    const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
    const [fps, setFps] = useState(0);
    const timeRef = useRef(0);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                setDimensions({ width: Math.floor(width), height: Math.floor(height) });
            }
        });
        observer.observe(container);
        return () => observer.disconnect();
    }, []);

    const drawFrame = useCallback((timestamp: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // FPS
        if (lastTimeRef.current > 0) {
            const delta = timestamp - lastTimeRef.current;
            const currentFps = 1000 / delta;
            fpsHistoryRef.current.push(currentFps);
            if (fpsHistoryRef.current.length > 30) fpsHistoryRef.current.shift();
            const avgFps = fpsHistoryRef.current.reduce((a, b) => a + b, 0) / fpsHistoryRef.current.length;
            setFps(Math.round(avgFps));
        }
        lastTimeRef.current = timestamp;
        timeRef.current = timestamp * 0.001;

        const w = dimensions.width;
        const h = dimensions.height;
        canvas.width = w;
        canvas.height = h;

        ctx.fillStyle = '#0a0a0f';
        ctx.fillRect(0, 0, w, h);

        // Grid
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
        ctx.lineWidth = 1;
        const gridSize = 40;
        for (let x = 0; x < w; x += gridSize) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }
        for (let y = 0; y < h; y += gridSize) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }

        const cx = w / 2;
        const cy = h / 2;
        const t = timeRef.current;

        if (isPlaying) {
            // Particles
            for (let i = 0; i < 20; i++) {
                const px = (Math.sin(t * 0.5 + i * 1.7) * 0.4 + 0.5) * w;
                const py = (Math.cos(t * 0.3 + i * 2.3) * 0.4 + 0.5) * h;
                const size = 2 + Math.sin(t + i) * 1;
                const alpha = 0.15 + Math.sin(t * 0.8 + i) * 0.1;
                ctx.fillStyle = `rgba(139, 92, 246, ${alpha})`;
                ctx.beginPath(); ctx.arc(px, py, size, 0, Math.PI * 2); ctx.fill();
            }

            // Bouncing logo
            const logoY = cy - 20 + Math.sin(t * 2) * 15;
            const logoScale = 1 + Math.sin(t * 3) * 0.05;
            ctx.save();
            ctx.translate(cx, logoY);
            ctx.scale(logoScale, logoScale);
            const gradient = ctx.createRadialGradient(0, 0, 10, 0, 0, 60);
            gradient.addColorStop(0, 'rgba(139, 92, 246, 0.3)');
            gradient.addColorStop(1, 'rgba(139, 92, 246, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath(); ctx.arc(0, 0, 60, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = 'rgba(139, 92, 246, 0.8)';
            ctx.beginPath(); ctx.roundRect(-20, -20, 40, 40, 8); ctx.fill();
            ctx.fillStyle = 'white';
            ctx.font = 'bold 24px Inter, system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('A', 0, 1);
            ctx.restore();

            ctx.fillStyle = 'rgba(52, 211, 153, 0.7)';
            ctx.font = '12px Inter, system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('▶ Running (Fallback Mode)', cx, logoY + 50);
        } else {
            // Crosshair
            ctx.strokeStyle = 'rgba(139, 92, 246, 0.3)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(cx - 30, cy); ctx.lineTo(cx + 30, cy); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(cx, cy - 30); ctx.lineTo(cx, cy + 30); ctx.stroke();

            ctx.fillStyle = 'rgba(139, 92, 246, 0.5)';
            ctx.font = '11px Inter, monospace';
            ctx.textAlign = 'start';
            ctx.fillText('(0, 0)', cx + 8, cy - 8);

            ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
            ctx.font = 'bold 48px Inter, system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('AXIOM', cx, cy + 80);
            ctx.font = '14px Inter, system-ui, sans-serif';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
            ctx.fillText('Press ▶ to run your game', cx, cy + 108);
        }

        animFrameRef.current = requestAnimationFrame(drawFrame);
    }, [dimensions, isPlaying]);

    useEffect(() => {
        animFrameRef.current = requestAnimationFrame(drawFrame);
        return () => cancelAnimationFrame(animFrameRef.current);
    }, [drawFrame]);

    return (
        <div ref={containerRef} className="relative w-full h-full">
            <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
            {/* FPS counter */}
            <div className={`absolute top-2 right-2 px-2 py-0.5 bg-black/60 rounded text-xs font-mono z-10 ${isPlaying ? 'text-emerald-400' : 'text-zinc-500'}`}>
                {fps > 0 ? fps : '--'} FPS
            </div>
            {/* Viewport info */}
            <div className="absolute bottom-2 left-2 px-2 py-0.5 bg-black/60 rounded text-xs text-zinc-500 font-mono z-10">
                {dimensions.width}×{dimensions.height} · Fallback
            </div>
            {isPlaying && (
                <div className="absolute top-2 left-2 px-2 py-0.5 bg-amber-500/20 border border-amber-500/30 rounded text-xs text-amber-400 font-medium z-10">
                    ⚡ FALLBACK
                </div>
            )}
        </div>
    );
}

/**
 * WASM engine mode — renders the engine inside an iframe.
 */
function WasmEngine({ isPlaying }: { isPlaying: boolean }) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [engineFps, setEngineFps] = useState(0);
    const [engineState, setEngineState] = useState<'loading' | 'ready' | 'running' | 'stopped'>('loading');
    const { files, addConsoleEntry } = useEditorStore();

    // Connect the bridge once iframe loads
    useEffect(() => {
        const iframe = iframeRef.current;
        if (!iframe) return;

        const handleLoad = () => {
            engineBridge.connect(iframe);
        };

        // If iframe already loaded (cached), connect immediately
        if (iframe.contentDocument?.readyState === 'complete') {
            engineBridge.connect(iframe);
        }

        iframe.addEventListener('load', handleLoad);

        const unsubscribe = engineBridge.onMessage((msg) => {
            switch (msg.type) {
                case 'ready':
                    setEngineState('ready');
                    break;
                case 'started':
                    setEngineState('running');
                    break;
                case 'stopped':
                    setEngineState('stopped');
                    break;
                case 'fps':
                    setEngineFps(msg.value);
                    break;
                case 'console':
                    addConsoleEntry({
                        id: crypto.randomUUID(),
                        level: msg.level,
                        message: translateEngineMessage(msg.message),
                        timestamp: new Date().toISOString(),
                        source: 'engine',
                    });
                    break;
                case 'error':
                    addConsoleEntry({
                        id: crypto.randomUUID(),
                        level: 'error',
                        message: translateEngineMessage(msg.message),
                        timestamp: new Date().toISOString(),
                        source: 'engine',
                    });
                    break;
            }
        });

        return () => {
            iframe.removeEventListener('load', handleLoad);
            unsubscribe();
            engineBridge.disconnect();
        };
    }, [addConsoleEntry]);

    // Start/stop engine based on isPlaying
    useEffect(() => {
        if (isPlaying && engineBridge.isReady && !engineBridge.isRunning) {
            // Prepare file list: Axiom format → Godot native before sending to WASM.
            // Binaries are pulled from storage and base64-encoded so PNGs/audio/glb
            // survive the postMessage hop — without this step `preload("res://…")`
            // inside scripts would fail at runtime.
            let cancelled = false;
            (async () => {
                const textFiles: Array<{ path: string; content: string; encoding?: 'utf8' | 'base64' }> = files
                    .filter(f => f.content_type === 'text' && f.text_content != null)
                    .map(f => ({ path: f.path, content: f.text_content ?? '', encoding: 'utf8' as const }));

                const binaryCandidates = files.filter(f => f.content_type === 'binary' && f.storage_key);
                const binaryResults = await Promise.all(binaryCandidates.map(async f => {
                    try {
                        const res = await fetch(`/api/assets/serve?key=${encodeURIComponent(f.storage_key!)}`);
                        if (!res.ok) {
                            addConsoleEntry({
                                id: crypto.randomUUID(),
                                level: 'warn',
                                message: `[Axiom] Could not load binary ${f.path} (HTTP ${res.status})`,
                                timestamp: new Date().toISOString(),
                                source: 'engine',
                            });
                            return null;
                        }
                        const buf = await res.arrayBuffer();
                        return { path: f.path, content: arrayBufferToBase64(buf), encoding: 'base64' as const };
                    } catch (err) {
                        addConsoleEntry({
                            id: crypto.randomUUID(),
                            level: 'warn',
                            message: `[Axiom] Failed to fetch binary ${f.path}: ${err instanceof Error ? err.message : String(err)}`,
                            timestamp: new Date().toISOString(),
                            source: 'engine',
                        });
                        return null;
                    }
                }));
                if (cancelled) return;

                const axiomFiles = [
                    ...textFiles,
                    ...binaryResults.filter((x): x is NonNullable<typeof x> => x !== null),
                ];
                const godotFiles = translateProjectFiles(axiomFiles);
                engineBridge.startGame(godotFiles);
            })();
            return () => { cancelled = true; };
        } else if (!isPlaying && engineBridge.isRunning) {
            engineBridge.stopGame();
        }
    }, [isPlaying, files, engineState, addConsoleEntry]);

    return (
        <div className="relative w-full h-full">
            <iframe
                ref={iframeRef}
                src="/engine/axiom.html"
                className="w-full h-full border-0"
                allow="autoplay; fullscreen"
                sandbox="allow-scripts allow-same-origin"
            />

            {/* Loading overlay */}
            {engineState === 'loading' && (
                <div className="absolute inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-10">
                    <div className="flex flex-col items-center gap-3">
                        <Loader2 size={24} className="text-violet-400 animate-spin" />
                        <span className="text-sm text-zinc-400">Loading engine runtime...</span>
                    </div>
                </div>
            )}

            {/* FPS counter */}
            <div className={`absolute top-2 right-2 px-2 py-0.5 bg-black/60 rounded text-xs font-mono z-10 ${engineState === 'running' ? 'text-emerald-400' : 'text-zinc-500'}`}>
                {engineFps > 0 ? engineFps : '--'} FPS
            </div>

            {/* State indicator */}
            {engineState === 'running' && (
                <div className="absolute top-2 left-2 px-2 py-0.5 bg-emerald-500/20 border border-emerald-500/30 rounded text-xs text-emerald-400 font-medium z-10 animate-pulse">
                    ● LIVE
                </div>
            )}
        </div>
    );
}

/**
 * Main viewport component — switches between WASM engine and fallback canvas.
 */
export default function AxiomViewport() {
    const { isPlaying, engineStatus, engineProgress } = useEditorStore();
    const [engineCheck, setEngineCheck] = useState<EngineAvailability | null>(null);
    const [checking, setChecking] = useState(true);

    useEffect(() => {
        checkEngineAvailability().then((result) => {
            setEngineCheck(result);
            setChecking(false);
        });
    }, []);

    if (checking) {
        return (
            <div className="relative w-full h-full bg-[#0a0a0f] flex items-center justify-center">
                <Loader2 size={20} className="text-violet-400 animate-spin" />
            </div>
        );
    }

    const useWasm = engineCheck?.available ?? false;

    return (
        <div className="relative w-full h-full bg-[#0a0a0f] overflow-hidden">
            {useWasm ? (
                <WasmEngine isPlaying={isPlaying} />
            ) : (
                <FallbackCanvas isPlaying={isPlaying} />
            )}

            {/* Gizmo tool palette — visible only with a 3D node selected */}
            <GizmoToolbar />

            {/* Loading overlay (engine status from store) */}
            {engineStatus !== 'idle' && engineStatus !== 'ready' && engineStatus !== 'error' && (
                <div className="absolute inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-20">
                    <div className="flex flex-col items-center gap-4">
                        <Loader2 size={32} className="text-violet-400 animate-spin" />
                        <div className="text-sm text-zinc-400">
                            Loading Axiom Engine... {Math.round(engineProgress)}%
                        </div>
                        <div className="w-48 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500 rounded-full transition-all duration-300"
                                style={{ width: `${engineProgress}%` }}
                            />
                        </div>
                    </div>
                </div>
            )}

            {/* WASM not available indicator */}
            {!useWasm && !isPlaying && (
                <div className="absolute bottom-2 right-2 px-2 py-1 bg-black/60 rounded text-[10px] text-zinc-600 font-mono z-10 flex items-center gap-1">
                    <Zap size={10} />
                    WASM not compiled — using fallback
                </div>
            )}
        </div>
    );
}
