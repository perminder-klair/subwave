// iOS cannot decode chained Ogg reliably and ignores software volume controls. Touch-enabled
// Macintosh UAs identify iPadOS desktop mode.
export function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}

// WebKit (Safari, and every browser on iOS) can't hand a `filter: url(#…)` to
// Core Animation, so it runs SVG filters in software, over the whole filtered
// box, on every repaint inside it. A theme --finish filters the full player
// stage, which held desktop Safari to 13–19 fps on AXO (60 without it). The
// class lets globals.css drop such effects on WebKit only. `navigator.vendor`
// is Apple's in WebKit, Google's in Blink and empty in Gecko. Static string,
// inlined pre-paint like LITE_INIT_SCRIPT; no untrusted input reaches it.
export const WEBKIT_INIT_SCRIPT = `
  try {
    if (/^Apple/.test(navigator.vendor || '')) document.documentElement.classList.add('webkit');
  } catch (e) {}
`;
