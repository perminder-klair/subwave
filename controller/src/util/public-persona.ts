// What an unauthenticated ROSTER-WIDE read may say about a persona, shared by
// GET /schedule's persona index and GET /personas so the two cannot drift.
// id/name/avatar/tagline always; `soul` is a system prompt and rides only behind
// settings.privacy.publishPersonaSouls (default off). Never widen this to tts,
// skills or the behaviour dials. GET /dj is out of scope: it has always
// published the on-air persona's soul one at a time.

/** The subset of a stored persona these reads touch. */
export interface PersonaLike {
  id?: unknown;
  name?: unknown;
  tagline?: unknown;
  soul?: unknown;
}

/** What a listener-safe persona looks like on the wire. `soul` is absent —
 *  not empty — when the station hasn't opted in, so a client can tell "not
 *  published" from "published but blank". */
export interface PublicPersona {
  id: string;
  name: string;
  tagline: string;
  avatar: string;
  soul?: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Strict `=== true`: absent, null and any non-boolean read as OFF, so an
 * upgrade or a malformed value never opts a station in. */
export function soulsArePublic(s: { privacy?: { publishPersonaSouls?: unknown } } | null | undefined): boolean {
  return s?.privacy?.publishPersonaSouls === true;
}

/** One persona reduced to the public shape. `avatarUrl` is injected so this
 * module stays free of the route layer's URL conventions. */
export function publicPersonaShape(
  p: PersonaLike,
  withSouls: boolean,
  avatarUrl: string,
): PublicPersona {
  const base: PublicPersona = {
    id: str(p?.id),
    name: str(p?.name),
    tagline: str(p?.tagline),
    avatar: avatarUrl,
  };
  return withSouls ? { ...base, soul: str(p?.soul) } : base;
}

/**
 * Guest co-host ids, filtered to personas that still exist — the same rule
 * resolveShowShape applies, so /schedule and /now-playing agree on who is in the
 * booth. Ids only; clients join against the payload's persona index.
 */
export function publicGuestIds(
  guestPersonaIds: unknown,
  roster: readonly PersonaLike[],
): string[] {
  if (!Array.isArray(guestPersonaIds)) return [];
  return guestPersonaIds.filter(
    (gid): gid is string => typeof gid === 'string' && roster.some(p => p?.id === gid),
  );
}
