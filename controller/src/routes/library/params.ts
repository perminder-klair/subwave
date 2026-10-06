export function parseList(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => parseList(x));
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

export function parseIntSafe<T extends number | null>(v: unknown, dflt: T): number | T {
  if (v == null || v === '') return dflt;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : dflt;
}

export function encodeCursor(c: { albumOffset: number; songIndex: number }) {
  return Buffer.from(`${c.albumOffset}:${c.songIndex}`, 'utf8').toString('base64url');
}
export function decodeCursor(s: string): { albumOffset: number; songIndex: number } {
  if (!s) return { albumOffset: 0, songIndex: 0 };
  try {
    const decoded = Buffer.from(s, 'base64url').toString('utf8');
    const [a, b] = decoded.split(':');
    const albumOffset = parseInt(a, 10);
    const songIndex = parseInt(b, 10);
    if (!Number.isFinite(albumOffset) || !Number.isFinite(songIndex)) return { albumOffset: 0, songIndex: 0 };
    return { albumOffset, songIndex };
  } catch {
    return { albumOffset: 0, songIndex: 0 };
  }
}
