/**
 * Tiny toast/notification store. Surfaces transient messages that today get
 * lost in console.error or buried in inline panels (rate-limit warnings,
 * recompose failures, save conflicts).
 *
 * Usage:
 *   import { toast } from '@/lib/toast';
 *   toast.error('Map was modified elsewhere');
 *   toast.success('Saved');
 *   toast.warn('Rate limit reached');
 *
 * Render <Toaster /> once at the app root. Toasts auto-dismiss after their
 * duration (default 6s for errors, 4s for everything else); pass {sticky:true}
 * to require a manual close.
 */

import { create } from 'zustand';

export type ToastLevel = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
    id: string;
    level: ToastLevel;
    message: string;
    /** Optional small caption, e.g. action context. */
    detail?: string;
    /** ms; 0 means sticky. */
    duration: number;
}

interface ToastState {
    toasts: Toast[];
    push: (level: ToastLevel, message: string, opts?: { detail?: string; duration?: number; sticky?: boolean }) => string;
    dismiss: (id: string) => void;
}

const DEFAULT_DURATIONS: Record<ToastLevel, number> = {
    info: 4000,
    success: 4000,
    warn: 5000,
    error: 6000,
};

export const useToastStore = create<ToastState>((set) => ({
    toasts: [],
    push: (level, message, opts) => {
        const id = crypto.randomUUID().slice(0, 8);
        const duration = opts?.sticky ? 0 : (opts?.duration ?? DEFAULT_DURATIONS[level]);
        set(s => ({ toasts: [...s.toasts, { id, level, message, detail: opts?.detail, duration }] }));
        return id;
    },
    dismiss: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}));

/** Imperative API. Safe to call from anywhere (event handlers, async fns,
 *  store actions) — no React context needed. */
export const toast = {
    info: (m: string, o?: { detail?: string; duration?: number; sticky?: boolean }) =>
        useToastStore.getState().push('info', m, o),
    success: (m: string, o?: { detail?: string; duration?: number; sticky?: boolean }) =>
        useToastStore.getState().push('success', m, o),
    warn: (m: string, o?: { detail?: string; duration?: number; sticky?: boolean }) =>
        useToastStore.getState().push('warn', m, o),
    error: (m: string, o?: { detail?: string; duration?: number; sticky?: boolean }) =>
        useToastStore.getState().push('error', m, o),
    dismiss: (id: string) => useToastStore.getState().dismiss(id),
};
