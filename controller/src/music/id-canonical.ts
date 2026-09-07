// Port of Navidrome PR #5824's canonicalID() — the deterministic, idempotent
// shape transform its `uniform_canonical_ids` migration applies to every id in
// the Navidrome DB. When that release lands, most media_file/playlist ids
// change value; replaying the same transform over our stored ids lets the sync
// walk ADOPT rotated rows (library-db/id-adoption.ts) instead of pruning a
// whole library's worth of tags, analysis and vectors.
//
// Shape rules (anything else, including share ids and empty strings, passes
// through unchanged):
//   len 22 — parse as base62; unparseable or value < 2^128 → unchanged
//            (hash-family ids and ~13% of nanoids); overflow → md5 of the id
//            STRING, re-encoded.
//   len 32 — hex → value-preserving base62 re-encode (legacy MD5 track ids).
//   len 36 — UUID (dashes at 8/13/18/23) → same re-encode (old playlist ids).
//
// The alphabet is Go big.Int's base-62 digit set — 0-9, a-z, A-Z, lowercase
// BEFORE uppercase, NOT the common base62 ordering. Golden vectors from the
// PR's own tests pin every branch in scripts/id-canonical.test.ts; adoption
// additionally requires each mapped id to exist in the freshly-walked live-id
// set, so upstream drift degrades to today's prune, never to a wrong rewrite.

import { createHash } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = new Map([...ALPHABET].map((ch, i) => [ch, BigInt(i)]));
const TWO_128 = 1n << 128n;
const HEX32 = /^[0-9a-fA-F]{32}$/;

// Renders a 16-byte value as the canonical 22-char zero-padded base62 id —
// byte-for-byte Go's id.Encode.
export function encode128(bytes: Uint8Array): string {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  let out = '';
  while (v > 0n) {
    out = ALPHABET[Number(v % 62n)] + out;
    v /= 62n;
  }
  return out.padStart(22, '0');
}

function decodeBase62(s: string): bigint | null {
  let v = 0n;
  for (const ch of s) {
    const d = DIGITS.get(ch);
    if (d === undefined) return null;
    v = v * 62n + d;
  }
  return v;
}

export function canonicalId(s: string): string {
  switch (s.length) {
    case 22: {
      const v = decodeBase62(s);
      if (v === null || v < TWO_128) return s;
      return encode128(createHash('md5').update(s, 'utf8').digest());
    }
    case 32: {
      if (!HEX32.test(s)) return s;
      return encode128(Buffer.from(s, 'hex'));
    }
    case 36: {
      if (s[8] !== '-' || s[13] !== '-' || s[18] !== '-' || s[23] !== '-') return s;
      const hex = s.slice(0, 8) + s.slice(9, 13) + s.slice(14, 18) + s.slice(19, 23) + s.slice(24);
      if (!HEX32.test(hex)) return s;
      return encode128(Buffer.from(hex, 'hex'));
    }
  }
  return s;
}
