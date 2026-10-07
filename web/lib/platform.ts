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
