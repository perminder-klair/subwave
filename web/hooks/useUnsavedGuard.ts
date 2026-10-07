'use client';

// Intercept in-app links before Next navigation and use beforeunload for tab exits. Leave browser
// Back alone; a decoy history entry would disrupt normal navigation.

import { useEffect, useRef } from 'react';

/** `onNavigate` receives the intercepted in-app destination (path + query +
 *  hash); the caller owns the prompt and the subsequent `router.push`. */
export function useUnsavedGuard(active: boolean, onNavigate: (href: string) => void): void {
  // A ref so a caller passing an inline arrow doesn't re-register the listeners
  // on every render.
  const cb = useRef(onNavigate);
  cb.current = onNavigate;

  useEffect(() => {
    if (!active) return;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers still key off returnValue; the string is never shown.
      e.returnValue = '';
    };

    const onClick = (e: MouseEvent) => {
      // Anything but a plain left click means a new tab, context menu or
      // download, none of which lose the pending work.
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as Element | null;
      const a = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const raw = a.getAttribute('href') || '';
      if (!raw || raw.startsWith('#')) return;
      let url: URL;
      try {
        url = new URL(a.href, window.location.href);
      } catch {
        return;
      }
      // Off-origin navigations unload the document, so beforeunload already
      // prompts — intercepting here would double up.
      if (url.origin !== window.location.origin) return;
      // A link back to this very screen changes nothing.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      cb.current(`${url.pathname}${url.search}${url.hash}`);
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [active]);
}
