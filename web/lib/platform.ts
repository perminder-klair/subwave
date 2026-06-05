// Client-only platform detection shared across the player.
//
// iOS / iPadOS is a special case for two unrelated reasons:
//   • its Opus decoder chokes on Icecast's chained-Ogg boundary (usePlayer
//     pins it to the MP3 mount), and
//   • Safari makes HTMLMediaElement.volume read-only and the only software
//     workaround — a Web Audio GainNode — both risks lock-screen / background
//     playback and is itself ignored inside an installed PWA (WKWebView). So
//     the transport bar shows a hardware-volume hint on iOS instead of a dead
//     slider (issue #298).
//
// iPadOS 13+ reports a desktop "Macintosh" UA, so we also treat a Mac-UA
// device that reports touch points as iOS — no real Mac has a touchscreen.
export function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}
