// Format a number of seconds as m:ss.
export function fmtClock(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// MM:SS for the LCD column — zero-padded minutes too, so the digits don't
// jitter horizontally as tracks cross the 10-minute mark.
export function lcdClock(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '00:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// A unicode block progress bar `width` cells wide.
export function progressBar(progress, width) {
  const p = Math.max(0, Math.min(1, progress || 0));
  const filled = Math.round(p * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

// Truncate (or pad) `text` to fit inside `width` cells, with `░▒▓` shimmer
// on both ends — the Winamp marquee look. We do NOT scroll: animating
// would need a per-frame tick, and Ink visibly flashes the whole frame on
// frequent re-renders (see NowPlaying.jsx). The marquee re-centres on
// each station-feed poll, which is enough movement to feel alive.
const SHIM_L = '░▒▓ ';
const SHIM_R = ' ▓▒░';
export function marquee(text, width) {
  const inner = Math.max(0, width - SHIM_L.length - SHIM_R.length);
  let body = (text || '').replace(/\s+/g, ' ').trim();
  if (body.length > inner) body = body.slice(0, Math.max(0, inner - 1)) + '…';
  else body = body + ' '.repeat(inner - body.length);
  return SHIM_L + body + SHIM_R;
}

// Deterministic faux-spectrum bar string `width` cells wide, driven by a
// `seed` string (we feed it the current track title + a coarse elapsed
// bucket). The output is stable for a given seed — looks like a frozen VU
// reading between polls, which is honest: we have no PCM to analyse from
// a child-process player, so anything moving would be a lie.
const RAMP = '▁▂▃▄▅▆▇';
function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}
export function spectrumBars(seed, width) {
  const base = hashStr(String(seed || 'subwave'));
  let out = '';
  for (let i = 0; i < width; i++) {
    // Mix the column index back into the hash so neighbours differ.
    const h = hashStr(`${base}:${i}`);
    out += RAMP[h % RAMP.length];
  }
  return out;
}
