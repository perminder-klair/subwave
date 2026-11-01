// What a Last.fm tag response means, and how a track's tags join its artist's.
// Pure: music/lastfm.ts does the asking, this decides what the answer is worth.
//
// The verdict is what the backfill's resumability rests on. Only 'answer' and
// 'miss' may stamp a row as done, so anything not positively either falls to
// 'transient': an outage, a bad key or a reply of unknown shape leaves the track
// owed, and the cost of being wrong is one more call on a later pass. The other
// direction would mark a library finished that was never asked about.

import { nameKey } from './recency.js';

export type TopTagsVerdict = 'answer' | 'miss' | 'rate-limited' | 'transient';

// Last.fm reports an unknown artist or track as error 6 ("invalid parameters"),
// and 7 is its "invalid resource". We always send both parameters, so either
// means the same thing here: asking again would get the same reply.
const NOT_FOUND_ERRORS = new Set([6, 7]);
const RATE_LIMIT_ERROR = 29;

// Errors arrive as `{ error, message }` under a 200 or a 4xx alike, so the body
// is read before the status. A 200 with no `toptags` at all is not an empty
// answer (that is `toptags` with no `tag`): it is a reply we don't understand.
export function classifyTopTagsResponse(status: number, body: unknown): TopTagsVerdict {
  const reply = (body && typeof body === 'object' ? body : {}) as { error?: unknown; toptags?: unknown };
  const error = Number(reply.error);
  if (status === 429 || error === RATE_LIMIT_ERROR) return 'rate-limited';
  if (NOT_FOUND_ERRORS.has(error)) return 'miss';
  if (reply.error || status < 200 || status >= 300) return 'transient';
  return reply.toptags && typeof reply.toptags === 'object' ? 'answer' : 'transient';
}

// Track tags are noisier than artist tags, and the commonest noise is the song
// or the act tagged with its own name, which says nothing about how it sounds.
// Deliberately not a junk list: those need curating, and these two need nothing.
export function dropNameEchoes(tags: string[], names: { artist: string; title: string }): string[] {
  const artist = nameKey(names.artist);
  const title = nameKey(names.title);
  return tags.filter((tag) => {
    const key = nameKey(tag);
    return key !== artist && key !== title;
  });
}

// How many of the artist's top tags outlast a song with a full list of its own.
// Track tags are the noisier source, and a never-play `tag` rule or a Musical
// Leaning is written against what the act is known for: without this, a popular
// song's own ten tags would take it out of reach of both.
const RESERVED_ARTIST_TAGS = 3;

// The one list every consumer reads: the track's own tags first, because they
// are what separates two songs by one act, then the artist's until the cap. The
// artist's top tags always get a place, and only a tag outside them spends the
// rest of the room.
export function mergeCrowdTags(trackTags: string[], artistTags: string[], cap = 10): string[] {
  const byKey = new Map<string, string>();
  for (const tag of [...trackTags, ...artistTags]) {
    const key = nameKey(tag);
    if (key && !byKey.has(key)) byKey.set(key, tag);
  }
  const artistKeys = [...new Set(artistTags.map(nameKey).filter(Boolean))];
  const reserved = new Set(artistKeys.slice(0, Math.min(RESERVED_ARTIST_TAGS, cap)));
  let room = cap - reserved.size;
  const merged: string[] = [];
  for (const [key, tag] of byKey) {
    if (reserved.has(key)) merged.push(tag);
    else if (room > 0) {
      merged.push(tag);
      room -= 1;
    }
  }
  return merged;
}
