'use client';

import { useEffect, useRef } from 'react';
import { useEditorStore } from '@/lib/store';
import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    Film,
} from 'lucide-react';

export default function AnimationTimeline() {
    const {
        assets, previewAssetId,
        animCurrentFrame, animIsPlaying, animFps,
        setAnimCurrentFrame, setAnimIsPlaying, setAnimFps,
    } = useEditorStore();

    const animRef = useRef<number>(0);
    const lastFrameTime = useRef(0);

    const asset = assets.find(a => a.id === previewAssetId) ?? null;
    // Treat sprite_sheet and animation types as sprite sheets; also detect
    // strip-like images so legacy animations render frame-by-frame.
    const imageFormats = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'];
    const isImage = asset ? imageFormats.includes(asset.file_format) : false;
    const explicitlySheet = asset?.asset_type === 'sprite_sheet' || asset?.asset_type === 'animation';
    const ratio = asset?.width && asset?.height && asset.height > 0 ? asset.width / asset.height : 0;
    const aspectSuggestsSheet = ratio >= 1.8 && Math.abs(ratio - Math.round(ratio)) < 0.15;
    const isSpriteSheet = isImage && (explicitlySheet || aspectSuggestsSheet);
    // Frame count priority: stored metadata.frames > width/height ratio (square-frame
    // assumption for PixelLab animations) > legacy fallback of 4. Covers older
    // animations that were persisted before metadata.frames was populated.
    const storedFrames = asset?.metadata?.frames?.length;
    const ratioFrames = ratio > 0 ? Math.max(1, Math.round(ratio)) : 0;
    const frameCount = storedFrames || ratioFrames || 4;

    // Animation loop
    useEffect(() => {
        if (!animIsPlaying || !isSpriteSheet) {
            cancelAnimationFrame(animRef.current);
            return;
        }

        const interval = 1000 / animFps;
        const animate = (time: number) => {
            if (time - lastFrameTime.current >= interval) {
                lastFrameTime.current = time;
                setAnimCurrentFrame((animCurrentFrame + 1) % frameCount);
            }
            animRef.current = requestAnimationFrame(animate);
        };
        animRef.current = requestAnimationFrame(animate);
        return () => cancelAnimationFrame(animRef.current);
    }, [animIsPlaying, animFps, frameCount, animCurrentFrame, setAnimCurrentFrame, isSpriteSheet]);

    // No asset selected or not a sprite sheet — show empty timeline
    if (!asset || !isSpriteSheet) {
        return (
            <div className="h-full flex flex-col bg-zinc-950 border-t border-white/5">
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5">
                    <Film size={12} className="text-zinc-600" />
                    <span className="text-[10px] uppercase tracking-wider text-zinc-600">Timeline</span>
                </div>
                <div className="flex-1 flex items-center justify-center text-zinc-700 text-xs">
                    {asset ? 'Select a sprite sheet to see animation timeline' : 'No asset selected'}
                </div>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col bg-zinc-950 border-t border-white/5">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5">
                <div className="flex items-center gap-2">
                    <Film size={12} className="text-violet-400" />
                    <span className="text-[10px] uppercase tracking-wider text-zinc-400">Timeline</span>
                    <span className="text-[10px] text-zinc-600">{asset.name}</span>
                </div>
                <span className="text-[10px] text-zinc-500 font-mono">
                    Frame {animCurrentFrame + 1}/{frameCount} @ {animFps}fps
                </span>
            </div>

            {/* Transport + Frame strip */}
            <div className="flex-1 flex items-center gap-3 px-3 overflow-hidden">
                {/* Transport controls */}
                <div className="flex items-center gap-0.5 flex-shrink-0">
                    <button
                        onClick={() => { setAnimCurrentFrame(0); setAnimIsPlaying(false); }}
                        className="p-1.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                        title="First frame"
                    >
                        <SkipBack size={14} />
                    </button>
                    <button
                        onClick={() => setAnimIsPlaying(!animIsPlaying)}
                        className={`p-1.5 rounded transition-colors ${
                            animIsPlaying ? 'text-emerald-400 bg-emerald-500/10' : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
                        }`}
                        title={animIsPlaying ? 'Pause' : 'Play'}
                    >
                        {animIsPlaying ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                    <button
                        onClick={() => { setAnimCurrentFrame(frameCount - 1); setAnimIsPlaying(false); }}
                        className="p-1.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                        title="Last frame"
                    >
                        <SkipForward size={14} />
                    </button>
                </div>

                {/* Divider */}
                <div className="w-px h-6 bg-white/10 flex-shrink-0" />

                {/* FPS control */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className="text-[10px] text-zinc-600">FPS</span>
                    <input
                        type="range"
                        min={1} max={60} value={animFps}
                        onChange={e => setAnimFps(Number(e.target.value))}
                        className="w-16 accent-violet-500 h-1"
                    />
                    <input
                        type="number"
                        min={1} max={60} value={animFps}
                        onChange={e => setAnimFps(Number(e.target.value))}
                        className="w-10 bg-zinc-900 border border-white/10 rounded px-1 py-0.5 text-[10px] text-zinc-300 text-center focus:outline-none focus:border-violet-500/50"
                    />
                </div>

                {/* Divider */}
                <div className="w-px h-6 bg-white/10 flex-shrink-0" />

                {/* Frame strip */}
                <div className="flex-1 flex items-center gap-1 overflow-x-auto py-1">
                    {Array.from({ length: frameCount }, (_, i) => (
                        <button
                            key={i}
                            onClick={() => { setAnimCurrentFrame(i); setAnimIsPlaying(false); }}
                            className={`flex-shrink-0 min-w-[28px] h-7 rounded border transition-all flex items-center justify-center text-[9px] font-mono ${
                                animCurrentFrame === i
                                    ? 'border-violet-500 bg-violet-500/20 text-violet-300'
                                    : 'border-white/5 bg-zinc-900 text-zinc-600 hover:border-white/10 hover:text-zinc-400'
                            }`}
                        >
                            {i + 1}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
