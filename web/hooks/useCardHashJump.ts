// Scroll to and flash the admin card a URL hash names, once, on arrival:
// `/admin/debug#llm-recent-calls` lands on the card whose `data-card` slug is
// `llm-recent-calls` (ui.tsx cardAnchor). Cards render only after their page's
// data loads, so this watches across frames instead of looking once at mount,
// and gives up quietly if the card never appears. The flash is the same
// `data-flash` the Settings search jump uses.
import { useEffect } from 'react';

const MAX_FRAMES = 600; // ~10s at 60fps: a slow first fetch still lands
const FLASH_MS = 2600;
// Clears the admin shell's sticky top bar, which would otherwise sit over the
// card's own title.
const TOP_CLEARANCE = '72px';

export function useCardHashJump(): void {
  useEffect(() => {
    const slug = decodeURIComponent(window.location.hash.slice(1));
    // Only a cardAnchor-shaped slug: it is interpolated into a selector.
    if (!/^[a-z0-9-]+$/.test(slug)) return;
    let frames = 0;
    let raf = 0;
    let flash: number | undefined;
    const settle = () => {
      const el = document.querySelector(`[data-card="${slug}"]`);
      if (!(el instanceof HTMLElement)) {
        if (frames++ < MAX_FRAMES) raf = window.requestAnimationFrame(settle);
        return;
      }
      el.style.scrollMarginTop = TOP_CLEARANCE;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.setAttribute('data-flash', '');
      flash = window.setTimeout(() => {
        el.removeAttribute('data-flash');
        el.style.removeProperty('scroll-margin-top');
      }, FLASH_MS);
    };
    raf = window.requestAnimationFrame(settle);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(flash);
    };
  }, []);
}
