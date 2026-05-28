// AI SDK tool library — real-world data tools the segment-director agent
// (skills/_agent.js) calls before deciding whether to air a between-track
// segment. The counterpart of llm/tools.js (music discovery): that set lets
// the DJ agent explore the library, this one lets it look at the world.
//
// Tools are built per tick and scoped to the capabilities currently on offer
// (off-cooldown, enabled, in-window) — a tool the agent shouldn't use simply
// isn't in the set. The shared `state` object carries dedup memory between
// ticks: seen headline hashes, the last weather condition aired, the last
// artist searched.

import { tool } from 'ai';
import { z } from 'zod';
import { queue } from '../broadcast/queue.js';
import { fetchHeadlines, hashHeadline } from '../skills/news.js';
import { searchWeb, searchReady } from '../skills/web-search.js';
import { fetchOnThisDay, hashCuriosity } from '../skills/curiosity.js';
import { getArtist, searchArtists } from '../music/subsonic.js';

// `caps` is the list of capabilities offered this tick (see skills/_agent.js).
// Only data-backed kinds get a tool — traffic is pure generation and needs none.
// `curiosity` has a data tool but the agent is free to fall through to pure
// generation under cap.desc when the tool returns `available: false`.
export function buildSegmentTools(ctx: any, state: any, caps: any[]) {
  const kinds = new Set(caps.map((c: any) => c.kind));
  const tools: any = {};

  if (kinds.has('weather')) {
    tools.checkWeather = tool({
      description: 'Get the current weather and whether it has changed since the DJ last spoke about weather on air. Dull or unchanged weather is usually not worth airing. The temperature is returned in the unit indicated by `tempUnit` ("C" or "F") — read it on air in that unit, do not convert.',
      inputSchema: z.object({}),
      execute: async () => {
        const w = ctx.weather;
        if (!w || !w.condition || w.condition === 'unknown') return { available: false };
        return {
          available: true,
          location: w.location,
          condition: w.condition,
          temp: w.temp ?? null,
          tempUnit: w.tempUnit || 'C',
          changedSinceLastMention: w.condition !== state.lastWeatherCondition,
        };
      },
    });
  }

  if (kinds.has('news')) {
    tools.getHeadlines = tool({
      description: 'Fetch current news headlines from the configured feed. Returns only headlines not already read on air.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const items = await fetchHeadlines();
          const fresh = items.filter((it: any) => !state.seenHeadlines.has(hashHeadline(it.title)));
          // Mark surfaced headlines as seen so a later tick doesn't re-offer
          // them — same "burn on read" approach as the old news skill.
          for (const it of fresh.slice(0, 6) as any[]) state.seenHeadlines.add(hashHeadline(it.title));
          if (state.seenHeadlines.size > 120) {
            state.seenHeadlines = new Set(Array.from(state.seenHeadlines).slice(-60));
          }
          if (!fresh.length) return { headlines: [] };
          return { headlines: fresh.slice(0, 6).map((it: any) => ({ title: it.title, detail: it.description || null })) };
        } catch (err) {
          return { error: err.message };
        }
      },
    });
  }

  if (kinds.has('curiosity')) {
    tools.getCuriosityItem = tool({
      description: 'Fetch one historical "on this day" event for today\'s date — filtered for cultural / scientific / sporting entries since 1850, and de-duped against curiosities already aired. Returns `available: false` when no fresh item exists; treat that as a cue to fall back to your own oddly-specific factoid under the capability brief, not as a reason to stay silent.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const items = await fetchOnThisDay();
          const fresh = items.filter((it: any) => !state.seenCuriosity.has(hashCuriosity(it.text)));
          if (!fresh.length) return { available: false };
          // Burn-on-read: claim what we surface so a later tick doesn't re-offer it.
          for (const it of fresh.slice(0, 3) as any[]) state.seenCuriosity.add(hashCuriosity(it.text));
          if (state.seenCuriosity.size > 200) {
            state.seenCuriosity = new Set(Array.from(state.seenCuriosity).slice(-100));
          }
          return {
            available: true,
            items: fresh.slice(0, 3).map((it: any) => ({ year: it.year, text: it.text })),
          };
        } catch (err) {
          return { error: err.message };
        }
      },
    });
  }

  if (kinds.has('album-anniversary')) {
    tools.checkAlbumAnniversary = tool({
      description: 'Check whether the album currently on air is hitting a round-number anniversary (5/10/20/25y) this year. Returns the album, the artist, and the year count when one applies; `available: false` otherwise.',
      inputSchema: z.object({}),
      execute: async () => {
        const track = queue.current?.track as any;
        const albumName = track?.album;
        const albumYear = Number(track?.year);
        const artistName = track?.artist;
        if (!albumName || !artistName) return { available: false };
        if (!Number.isFinite(albumYear) || albumYear < 1900) return { available: false };
        const years = new Date().getFullYear() - albumYear;
        if (years < 5) return { available: false };
        if (years % 5 !== 0) return { available: false };
        return {
          available: true,
          album: albumName,
          artist: artistName,
          years,
          releasedYear: albumYear,
        };
      },
    });
  }

  if (kinds.has('library-deep-cut')) {
    tools.findDeepCut = tool({
      description: 'Find a track by the on-air artist that lives in the operator\'s library but has NOT been played in the last 30 days. Returns at most a handful of candidates plus a count; `available: false` if the artist has nothing cold to surface. Do NOT name a specific track unless exactly one is returned.',
      inputSchema: z.object({}),
      execute: async () => {
        const artistName = queue.current?.track?.artist;
        if (!artistName || /^unknown/i.test(artistName)) return { available: false };
        try {
          // Resolve the artist id — search3 returns artist matches, take the best one.
          const matches = await searchArtists(artistName, { artistCount: 3 });
          const artist = matches.find((a: any) => a.name?.toLowerCase() === artistName.toLowerCase())
                       || matches[0];
          if (!artist?.id) return { available: false };
          const detail = await getArtist(artist.id);
          const albums = Array.isArray(detail?.album) ? detail.album : [];
          if (!albums.length) return { available: false };
          const { ids, keys } = queue.recentlyPlayed(30 * 24); // 30 days
          // Walk a bounded slice of albums (cheapest viable: top 8 by year/recent).
          // We only need to know whether at least one cold track exists.
          const cold: { title: string; album: string }[] = [];
          const { getAlbum } = await import('../music/subsonic.js');
          for (const album of albums.slice(0, 8)) {
            const songs = await getAlbum(album.id);
            for (const s of songs) {
              const songId = String(s?.id || '');
              const key = `${(s?.title || '').toLowerCase().trim()}|${(s?.artist || artistName).toLowerCase().trim()}`;
              if (songId && ids.has(songId)) continue;
              if (keys.has(key)) continue;
              if (!s?.title) continue;
              cold.push({ title: s.title, album: album.name || '' });
              if (cold.length >= 6) break;
            }
            if (cold.length >= 6) break;
          }
          if (!cold.length) return { available: false };
          return { available: true, artist: artistName, count: cold.length, candidates: cold };
        } catch (err) {
          return { error: err.message };
        }
      },
    });
  }

  if (kinds.has('web-search') && searchReady()) {
    tools.searchArtistNews = tool({
      description: 'Search the web for something recent about the artist currently on air.',
      inputSchema: z.object({}),
      execute: async () => {
        const artist = queue.current?.track?.artist;
        if (!artist || /^unknown/i.test(artist)) return { available: false };
        const alreadySearched = artist === state.lastSearchedArtist;
        try {
          const data = await searchWeb(`${artist} musician latest news`);
          state.lastSearchedArtist = artist;
          const answer = (data.answer || '').trim();
          const sources = (data.results || [])
            .slice(0, 3)
            .map(r => `${r.title}: ${(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 240)}`);
          if (!answer && sources.length === 0) return { available: false };
          return { artist, alreadySearched, answer, sources };
        } catch (err) {
          return { error: err.message };
        }
      },
    });
  }

  return tools;
}
