import type { NotebookSnapshot } from '../../../skills/notebook.js';
import * as settings from '../../../settings.js';
import { findSkillPersona, type PersonaIdentity } from '../../../skills/special-guest.js';
import { laterTodayProgramming } from '../../../skills/look-ahead.js';
import { randomLibraryArtist } from '../../../music/episode-source.js';
// Station services — the curated facade a skill's data tool (a built-in or an
// operator's custom tool.mjs) gets to look at the world before the DJ speaks.
// This is the SINGLE place segment tools reach into the controller's internals
// (web search, the music library, the queue, feeds, durable recall). It is
// passed as the third argument to every tool fetcher:
//
//   export default async (ctx, state, services) => data
//
// so the contract stays backward-compatible — existing two-arg custom skills
// ignore the third arg and keep working.
//
// The surface is deliberately READ-MOSTLY: search, library reads, play-log
// reads, a durable dedup store, and a log line. No writes to settings, no
// secrets, no queue mutation — a custom tool.mjs running here is the operator's
// own code (same trust model as a local Claude Code skill), fenced by the 8s
// timeout at the call site, but it still shouldn't be handed the whole booth.

import { queue } from '../../../broadcast/queue.js';
import { searchWeb, searchReady } from '../../../skills/web-search.js';
import { fetchOnThisDay, curiositySeen, recordCuriosity } from '../../../skills/curiosity.js';
import { fetchHeadlines, hashHeadline } from '../../../skills/feed.js';
import { getArtist, getAlbum, searchArtists } from '../../../music/subsonic.js';

export interface StationServices {
  notebook: { read: () => NotebookSnapshot | null };
  personas: { find: (query: string) => PersonaIdentity | null; onAirHost: () => PersonaIdentity | null };
  schedule: { laterToday: () => ReturnType<typeof laterTodayProgramming> };
  // Web search via the operator's configured provider (DuckDuckGo / Tavily /
  // Brave / SearXNG / Keenable). `searchReady()` is false when no provider is
  // usable.
  searchWeb: typeof searchWeb;
  searchReady: typeof searchReady;
  // The track currently on air (artist/title/album/year/id), or null.
  nowPlaying: () => any | null;
  // Play-log lookup over the last `hours` — { ids, keys } sets for dedup.
  recentPlays: (hours: number) => { ids: Set<string>; keys: Set<string> };
  // Subsonic/Navidrome library reads.
  library: { getArtist: typeof getArtist; getAlbum: typeof getAlbum; searchArtists: typeof searchArtists; randomArtist: typeof randomLibraryArtist };
  // Wikipedia "on this day" events for today's date.
  onThisDay: () => Promise<any[]>;
  // Fetch + parse an RSS feed (defaults to the configured news feed).
  fetchHeadlines: typeof fetchHeadlines;
  hashHeadline: typeof hashHeadline;
  // Durable, cross-restart dedup ledger — remember what was aired so it isn't
  // repeated days later. (Backs the curiosity skill; available to any skill.)
  recall: { seen: (key: string) => boolean; remember: (key: string) => void };
  // Append a namespaced line to the station event log.
  log: (msg: string) => void;
}

let cached: StationServices | null = null;

// Build (once) the services facade. The wrappers are stateless — `nowPlaying`,
// `recentPlays` etc. read live from the queue each call — so a single cached
// base instance is safe to reuse across ticks. A per-call schedule overlay
// binds the actual speaker without sharing voice identity between runs.
export function buildStationServices({ speakerPersonaId = null, notebookSnapshot = null }: { speakerPersonaId?: string | null; notebookSnapshot?: NotebookSnapshot | null } = {}): StationServices {
  cached ??= {
    notebook: { read: () => null },
    personas: {
      find: findSkillPersona,
      onAirHost: () => {
        const host = settings.getOnAirRoster().host;
        return host ? { id: host.id, name: host.name } : null;
      },
    },
    schedule: { laterToday: () => laterTodayProgramming() },
    searchWeb,
    searchReady,
    nowPlaying: () => queue.current?.track ?? null,
    recentPlays: (hours: number) => queue.recentlyPlayed(hours),
    library: { getArtist, getAlbum, searchArtists, randomArtist: randomLibraryArtist },
    onThisDay: () => fetchOnThisDay(),
    fetchHeadlines,
    hashHeadline,
    recall: { seen: (key: string) => curiositySeen(key), remember: (key: string) => recordCuriosity(key) },
    log: (msg: string) => queue.log('scheduler', `[skill] ${msg}`),
  };
  return speakerPersonaId || notebookSnapshot ? { ...cached,
    schedule: { laterToday: () => laterTodayProgramming(speakerPersonaId) },
    notebook: { read: () => notebookSnapshot ? structuredClone(notebookSnapshot) : null },
  } : cached;
}
