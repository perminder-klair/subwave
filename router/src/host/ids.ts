// Id namespacing. Plugins speak their backend's native ids; everything the
// router publishes is namespaced here, and everything it receives is decoded
// here. Centralising it is the point: the station stores these ids in about
// fifteen places (library.db, likes, blocklist, stems, …), so the rules below
// are not something each plugin author should have to get right.
//
// The published shape must satisfy every consumer at once:
//   - `^[\w-]{1,64}$` — the controller's /cover/:id guard (routes/public.ts)
//   - no '/'          — the stem cache keys a directory by basename(id)
//   - stable          — the same native id always encodes the same way
//   - reversible      — no lookup table that a restart would lose
//
// A native id that is already `[A-Za-z0-9_-]` travels as `<prefix>-<native>`.
// Anything else is base64url-encoded behind `<prefix>_`, so the separator
// alone says which decoding applies. Prefixes are `[a-z][a-z0-9]{1,5}`, which
// keeps every namespaced id out of the shapes music/id-canonical.ts rewrites:
// the prefix's separator sits inside the first eight characters, so the id is
// never 32 hex digits, never base62, and never a UUID.

export const MAX_ID_LENGTH = 64;
export const ID_PREFIX_RE = /^[a-z][a-z0-9]{1,5}$/;
const SAFE_RE = /^[A-Za-z0-9_-]+$/;

export interface IdCodec {
  /** Native → published, or undefined when the id cannot be carried. */
  encode(native: string): string | undefined;
  /** Published → native, or undefined when the id is not this source's. */
  decode(id: string): string | undefined;
  owns(id: string): boolean;
}

function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function fromBase64Url(s: string): string | undefined {
  if (!s || !SAFE_RE.test(s)) return undefined;
  const decoded = Buffer.from(s, 'base64url').toString('utf8');
  // Buffer decoding is lenient; only accept a payload that round-trips.
  return toBase64Url(decoded) === s ? decoded : undefined;
}

export function prefixedCodec(prefix: string): IdCodec {
  if (!ID_PREFIX_RE.test(prefix)) throw new Error(`invalid id prefix '${prefix}'`);
  const plain = `${prefix}-`;
  const packed = `${prefix}_`;
  const codec: IdCodec = {
    encode(native) {
      if (typeof native !== 'string' || native === '') return undefined;
      const out = SAFE_RE.test(native) ? plain + native : packed + toBase64Url(native);
      return out.length <= MAX_ID_LENGTH ? out : undefined;
    },
    decode(id) {
      if (typeof id !== 'string') return undefined;
      if (id.startsWith(plain)) {
        const native = id.slice(plain.length);
        return native && SAFE_RE.test(native) ? native : undefined;
      }
      if (id.startsWith(packed)) return fromBase64Url(id.slice(packed.length));
      return undefined;
    },
    owns(id) {
      return codec.decode(id) !== undefined;
    },
  };
  return codec;
}

// `rawIds`: the source's native ids are published unchanged. Used for exactly
// one case — a Navidrome library moving behind the router, whose ids are
// already in every store the station keeps. Only ids that already satisfy the
// published shape can travel raw; anything else is dropped (and logged by the
// caller), never silently re-encoded, because a re-encoded id would be a new
// id for a track the station already knows.
export function rawCodec(): IdCodec {
  return {
    encode(native) {
      if (typeof native !== 'string' || native === '') return undefined;
      return SAFE_RE.test(native) && native.length <= MAX_ID_LENGTH ? native : undefined;
    },
    decode(id) {
      return typeof id === 'string' && id !== '' && SAFE_RE.test(id) ? id : undefined;
    },
    owns(id) {
      return typeof id === 'string' && id !== '' && SAFE_RE.test(id);
    },
  };
}
