// Small helpers shared by the built-in sources. Third-party plugins bring
// their own; nothing here is part of the plugin contract (that is sdk/).

import crypto from 'node:crypto';

export const md5 = (s: string): string => crypto.createHash('md5').update(s).digest('hex');

// FNV-1a 32-bit — cheap stable hash for deriving per-id tones, colours, ordering.
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Seeded PRNG, so a generated library is identical on every boot.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Lowercase + strip diacritics — roughly how Subsonic servers match loosely.
export function norm(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}
