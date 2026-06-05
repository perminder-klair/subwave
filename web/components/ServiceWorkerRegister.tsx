'use client';

import { useEffect } from 'react';

// Registers /sw.js once on mount. Kept separate from PlayerApp so it also
// runs on the landing/admin/setup routes — the install prompt should work
// no matter which page the visitor lands on first.
export default function ServiceWorkerRegister(): null {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    // The PWA service worker is production-only. In dev it precaches hashed
    // webpack chunks that go stale on every `next dev` restart, surfacing as a
    // cryptic "Cannot read properties of undefined (reading 'call')" runtime
    // error. Actively tear down any SW + caches a prior prod/`next start` build
    // left registered on this origin so the dev server is never handed stale
    // assets — otherwise the stale SW keeps serving broken chunks and the page
    // never recovers on its own.
    if (process.env.NODE_ENV !== 'production') {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      if ('caches' in window) {
        caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
      }
      return;
    }

    if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
      // Browsers refuse SW over plain HTTP on non-localhost hosts. Skipping
      // the registration call avoids a noisy console error in those setups.
      return;
    }
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[sw] registration failed:', err);
    });
  }, []);
  return null;
}
