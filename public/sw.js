/**
 * Axiom Engine — minimal service worker.
 *
 * Goal: enable PWA install on Android/iOS by satisfying the "fetch handler"
 * requirement. We deliberately keep caching simple — the WASM engine is
 * versioned by the build pipeline (different filenames per build) so an
 * aggressive runtime cache would pin users to old builds. Instead we:
 *
 *   1. Precache the shell HTML + manifest on install.
 *   2. Network-first for everything else, falling back to cache when
 *      offline. The user gets the latest engine when online and a usable
 *      shell when not.
 *
 * Bump CACHE_NAME on schema changes to evict stale shells.
 */

const CACHE_NAME = 'axiom-shell-v1';
const SHELL_FILES = ['/engine/axiom.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {}),
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))),
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    // Skip cross-origin: we don't want to proxy supabase/pixellab.
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    event.respondWith(
        fetch(req)
            .then((res) => {
                // Only cache the shell files. Engine builds change per
                // deploy and we don't want to pin them; API responses are
                // never cached.
                if (SHELL_FILES.some((p) => url.pathname === p)) {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(req, copy));
                }
                return res;
            })
            .catch(() => caches.match(req).then((cached) => cached ?? Response.error())),
    );
});
