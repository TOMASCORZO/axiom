'use client';

import { useEffect } from 'react';
import { useToastStore, type ToastLevel } from '@/lib/toast';
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';

/**
 * Stacked toast renderer. Bottom-right, newest below older so the eye lands
 * on the most recent. Each toast auto-dismisses after its duration unless
 * sticky (duration === 0). Click X to dismiss early.
 *
 * Mount once in EditorLayout (or globally in app/layout.tsx).
 */

const LEVEL_STYLES: Record<ToastLevel, { ring: string; bg: string; text: string; iconClr: string }> = {
    info:    { ring: 'ring-zinc-500/30',    bg: 'bg-zinc-900/95',     text: 'text-zinc-200',    iconClr: 'text-zinc-400' },
    success: { ring: 'ring-emerald-500/40', bg: 'bg-emerald-950/90',  text: 'text-emerald-100', iconClr: 'text-emerald-400' },
    warn:    { ring: 'ring-amber-500/40',   bg: 'bg-amber-950/90',    text: 'text-amber-100',   iconClr: 'text-amber-400' },
    error:   { ring: 'ring-red-500/40',     bg: 'bg-red-950/90',      text: 'text-red-100',     iconClr: 'text-red-400' },
};

const ICONS: Record<ToastLevel, typeof CheckCircle2> = {
    info: Info,
    success: CheckCircle2,
    warn: AlertTriangle,
    error: AlertCircle,
};

interface ToastItemProps {
    id: string;
    level: ToastLevel;
    message: string;
    detail?: string;
    duration: number;
}

function ToastItem({ id, level, message, detail, duration }: ToastItemProps) {
    const dismiss = useToastStore(s => s.dismiss);
    const style = LEVEL_STYLES[level];
    const Icon = ICONS[level];

    useEffect(() => {
        if (duration <= 0) return; // sticky
        const t = setTimeout(() => dismiss(id), duration);
        return () => clearTimeout(t);
    }, [id, duration, dismiss]);

    return (
        <div
            role="status"
            className={`flex items-start gap-2 ${style.bg} ${style.text} backdrop-blur ring-1 ${style.ring} rounded-lg shadow-xl shadow-black/40 px-3 py-2 min-w-[260px] max-w-[400px] animate-in fade-in slide-in-from-bottom-2 duration-200`}
        >
            <Icon size={14} className={`${style.iconClr} flex-shrink-0 mt-0.5`} />
            <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium leading-snug">{message}</div>
                {detail && <div className="text-[10px] opacity-70 mt-0.5 leading-snug">{detail}</div>}
            </div>
            <button
                onClick={() => dismiss(id)}
                className={`${style.iconClr} hover:opacity-100 opacity-60 flex-shrink-0`}
                title="Dismiss"
                aria-label="Dismiss notification"
            >
                <X size={12} />
            </button>
        </div>
    );
}

export default function Toaster() {
    const toasts = useToastStore(s => s.toasts);
    if (toasts.length === 0) return null;
    return (
        <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-auto">
            {toasts.map(t => <ToastItem key={t.id} {...t} />)}
        </div>
    );
}
