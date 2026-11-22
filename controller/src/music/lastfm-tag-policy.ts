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

// How many of a song's own tags join its artist's. Track tags are the noisier
// source, and past the first few they thin out into labels one listener used.
export const MAX_TRACK_TAGS = 5;

// The one list every consumer reads: the song's own tags first, because they are
// what separates two songs by one act, then the whole of the artist's. Additive
// on purpose. The blocklist is absolute, and a never-play `tag` rule or a Musical
// Leaning is written against what the act is known for, so the artist's list is
// always a subset of this one and turning track tags on can only make a rule
// match more. The fold is the one those rules compare through (blocklist normText
// restates nameKey), so a repeat dropped here can't take a match with it.
export function mergeCrowdTags(trackTags: string[], artistTags: string[]): string[] {
  return oncePerFold([...trackTags.slice(0, MAX_TRACK_TAGS), ...artistTags]);
}

// What a row's first answer does with the list it already had. Last.fm's lists
// move, and a station with this off never re-reads them, so that list can hold
// tags the artist no longer shows, or come from an act Last.fm no longer answers
// for. Everything stays behind the answer: a rule written against what the row
// holds must not stop matching because the setting went on.
export function keepStoredTags(answer: string[], stored: string[]): string[] {
  return oncePerFold([...answer, ...stored]);
}

// What an artist-only lookup (`lastfm.getArtistTags`) does to the list a row
// holds, on the bulk pass and Retag alike (#2295). That call answers [] for an
// outage and for an act with no tags, and can't say which, so only a list with
// tags on it replaces the stored one. Anything else keeps it: a failure, a
// keyless Navidrome that never carries tags, or no lookup at all because Last.fm
// tags are off. A replacement is the answer whole, never a merge: with track tags
// off a re-ask puts the artist's current list back.
export function listAfterArtistLookup(stored: string[] | null, answer: string[] | null | undefined): string[] | null {
  return answer && answer.length ? answer : stored;
}

function oncePerFold(tags: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const tag of tags) {
    const key = nameKey(tag);
    if (key && !byKey.has(key)) byKey.set(key, tag);
  }
  return [...byKey.values()];
}
