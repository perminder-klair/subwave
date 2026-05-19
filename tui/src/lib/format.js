// Format a number of seconds as m:ss.
export function fmtClock(secs) {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// A unicode block progress bar `width` cells wide.
export function progressBar(progress, width) {
  const p = Math.max(0, Math.min(1, progress || 0));
  const filled = Math.round(p * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}
