// Scheduler — drives autonomous behaviour:
//   - refreshes the auto-playlist file Liquidsoap falls back to
//   - hourly time check (top of every hour, in character)
//   - station IDs (every ~45 min, varied by frequency setting)
//   - agentic segment tick (weather, news, now-playing digs, facts, web search) every 5 min

import cron from 'node-cron';
import { config } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import * as subsonic from '../music/subsonic.js';
import * as dj from '../llm/dj.js';
import * as library from '../music/library.js';
import * as settings from '../settings.js';
import { artistKey } from '../music/recency.js';
import { normGenre, genreMatches, inYearRange, preferEnergy, preferEnergyStrict, preferMood } from '../music/show-filter.js';
import { resolveShowPlaylistPool, resolveExcludedPlaylistIds } from '../music/show-playlist.js';
import { getFullContext } from '../context.js';
import { queue } from './queue.js';
import * as session from './session.js';
import * as djAgent from './dj-agent.js';
import { cleanupOldVoices } from '../audio/tts.js';
import { shouldFire } from './dj-gate.js';
import { djCallsAllowed } from './listeners.js';
import { optionalSegmentsAllowed } from './dj-budget.js';
import { agenticTick, skillCatalog } from '../skills/_agent.js';
import { withTrace, pruneOldEvents } from '../observability/events.js';
import * as archives from './archives.js';
import * as doctor from '../doctor.js';

const TARGET_POOL = 30;
const MOOD_WEIGHT = 12;          // up to this many mood-tagged tracks per pool
const PLAYLIST_WEIGHT = 6;       // mood-matched Navidrome playlists
const RECENT_WEIGHT = 4;         // recently-added albums
const FREQUENT_WEIGHT = 4;       // frequent / scrobble-favourite albums
const STARRED_WEIGHT = 6;        // hand-starred tracks
const AUTO_MAX_PER_ARTIST = 2;   // cap any one artist's share of the fallback pool
// When a scheduled show pins a genre/era, a dedicated Navidrome-genre source
// becomes the dominant pool contributor and the off-genre sources shrink by
// SHOW_NARROW_FACTOR so the show's genre/era actually fills the fallback (#629).
const SHOW_GENRE_WEIGHT = 14;        // dedicated show-genre source (soft lean)
const SHOW_GENRE_STRICT_WEIGHT = 24; // strict: this source carries most of the pool
// A show anchored to Navidrome playlist(s): the union becomes the dominant
// fallback source (soft) or — after the strict end-filter — the whole pool.
const SHOW_PLAYLIST_WEIGHT = 14;        // dedicated show-playlist source (soft)
const SHOW_PLAYLIST_STRICT_WEIGHT = 24; // strict: this source carries the pool
const SHOW_NARROW_FACTOR = 0.5;      // shrink mood/playlist/recent/etc. for shows

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5);
}

async function tracksFromAlbums(albums: any[], perAlbum: number, max: number) {
  const out: any[] = [];
  for (const a of albums) {
    if (out.length >= max) break;
    try {
      const songs = await subsonic.getAlbum(a.id);
      out.push(...shuffle(songs).slice(0, perAlbum));
    } catch {}
  }
  return out;
}

// ---------------------------------------------------------------------------
// AUTO-PLAYLIST REFRESH
// Writes an M3U with mood-appropriate tracks for Liquidsoap's fallback source.
// ---------------------------------------------------------------------------

export async function refreshAutoPlaylist() {
  return withTrace({ kind: 'auto-playlist' }, () => refreshAutoPlaylistInner());
}

async function refreshAutoPlaylistInner() {
  const ctx = await getFullContext();
  const mood = ctx.dominantMood;
  // Match the auto-DJ picker's window (dj-agent.pickViaAgent) — 12h.
  const recent = queue.recentlyPlayedIds(12);

  // The fallback is what airs when the live AI picks pause (e.g. pause-when-empty
  // with zero listeners). When a show is scheduled for this hour, the fallback
  // should stay on-brand exactly as the picker does — so we steer the pool by the
  // active show's genre / era / energy, mirroring music/picker.ts (issue #629).
  const show: any = settings.resolveActiveShow();
  const showGenre: string = show?.genre || '';
  const fromYear: number | null = show?.fromYear ?? null;
  const toYear: number | null = show?.toYear ?? null;
  const showEnergy: string = show?.energy || '';
  // A genre or a year window narrows the pool; energy alone only soft-leans
  // (mirrors picker.hasMusicFilter). Strict (show.filtersStrict) opts EVERY set
  // filter — mood, genre, era, energy — into a hard filter on the pool.
  const narrow = !!(show && (showGenre || fromYear != null || toYear != null));
  const showMood: string = show?.mood || '';
  const strict = !!(show?.filtersStrict && (showGenre || showMood || showEnergy || fromYear != null || toYear != null));

  // Show playlist anchor: resolve the union once. The fallback must honour it
  // too, so the LLM-free coast (LLM down, budget-hard, zero listeners) still
  // plays the show's playlist. Strict → the pool is hard-filtered to it at the
  // end (and the off-playlist random top-up is skipped); soft → it just
  // dominates. Null when the show pins no playlists.
  const playlistPool = show ? await resolveShowPlaylistPool(show) : null;
  const hasPlaylist = !!playlistPool?.tracks?.length;
  const strictPlaylist = hasPlaylist && !!show?.playlistStrict;
  const excludedIds = show ? await resolveExcludedPlaylistIds(show) : null;

  // Resolve the show's free-text genre to the library's exact tag once, up front.
  // A resolution failure / absent genre leaves genreName null, which disables the
  // strict hard-filter and the genre-targeted fetches — the documented degrade
  // path (a misspelled / library-absent genre falls back to the normal pool).
  let genreName: string | null = null;
  if (showGenre) {
    try { genreName = await subsonic.resolveGenreName(showGenre); } catch {}
  }
  const strictGenreNorm = strict && genreName ? normGenre(genreName) : null;
  // Strict: hard-drop off-genre / off-era tracks from every discovery source
  // (even if that empties the source) — the auto playlist airs in full with no
  // LLM gatekeeper, so never-starve off-target filler would actually play. The
  // dedicated genre source + genre/era-targeted random carry the pool; an
  // unresolved genre disables the genre drop (genreName null → no filter).
  // Mood and energy enforce with per-source never-starve instead (preferMood /
  // preferEnergyStrict): they depend on the tagger/analyzer having run, and an
  // un-tagged library hard-dropping everything would empty the dead-air
  // fallback entirely. Soft mode is a no-op here.
  const enforce = (items: any[]) => {
    let out = items;
    if (strictGenreNorm) out = out.filter((t: any) => genreMatches(t, strictGenreNorm));
    if (strict && (fromYear != null || toYear != null)) out = inYearRange(out, { fromYear, toYear });
    if (strict && showMood) out = preferMood(out, showMood);
    if (strict && showEnergy) out = preferEnergyStrict(out, showEnergy);
    return out;
  };
  // Shrink the off-genre / off-playlist sources so the dedicated show source
  // (genre or playlist) dominates the pool.
  const nz = (cap: number) => ((narrow || hasPlaylist) ? Math.max(2, Math.ceil(cap * SHOW_NARROW_FACTOR)) : cap);

  // Length cap: the active show's override or the station default (issue #447),
  // resolved in seconds. null = no cap. Now that the fallback honours the show's
  // genre/era it honours its track-length cap too.
  const maxDurationSec = settings.effectiveMaxTrackSec(show);

  const pool: any[] = [];
  const fromSource: Record<string, number> = { 'show-genre': 0, 'show-playlist': 0, mood: 0, playlist: 0, recent: 0, frequent: 0, starred: 0, random: 0 };
  // Cap each artist's share of the pool. Without this, a deep-catalogue artist
  // (many mood-tagged / starred / frequent tracks) can dominate the fallback
  // playlist, so whenever Liquidsoap coasts on auto.m3u the same artist clusters
  // on air — e.g. one artist's tracks airing 7× purely from this source.
  const artistInPool = new Map<string, number>();
  const take = (label: string, items: any[], cap: number) => {
    let n = 0;
    for (const t of items) {
      if (n >= cap || pool.length >= TARGET_POOL) break;
      if (!t?.id || recent.has(t.id) || pool.find((p: any) => p.id === t.id)) continue;
      const ak = artistKey(t);
      if (ak && (artistInPool.get(ak) || 0) >= AUTO_MAX_PER_ARTIST) continue;
      pool.push({ ...t, _source: label });
      fromSource[label] = (fromSource[label] || 0) + 1;
      if (ak) artistInPool.set(ak, (artistInPool.get(ak) || 0) + 1);
      n++;
    }
  };

  await library.load();

  // 0. Dedicated show-genre / era source — the dominant contributor whenever a
  // show pins a genre or a year window. Both Navidrome queries filter server-side,
  // so this source is inherently genre/era-pure (no never-starve pollution). Soft
  // energy lean on top. Placed first so genre-native tracks fill the pool before
  // the (shrunk) discovery sources add variety.
  if (narrow) {
    try {
      const collected: any[] = [];
      collected.push(...await subsonic.getRandomSongs({
        size: strict ? 60 : 40,
        genre: genreName || undefined,
        fromYear: fromYear ?? undefined,
        toYear: toYear ?? undefined,
      }));
      if (genreName) {
        const g = await subsonic.getSongsByGenre(genreName, { count: strict ? 100 : 60 });
        const ranged = inYearRange(g, { fromYear, toYear });
        collected.push(...(ranged.length ? ranged : g));
      }
      // Genre/era are server-side native here; enforce() adds the strict
      // mood/energy filters on top (no-op in soft mode).
      const leaned = enforce(preferEnergy(collected, showEnergy));
      take('show-genre', shuffle(leaned), strict ? SHOW_GENRE_STRICT_WEIGHT : SHOW_GENRE_WEIGHT);
    } catch (err) {
      queue.log('error', `Show-genre fetch failed: ${err.message}`);
    }
  }

  // 0b. Dedicated show-playlist source — the dominant contributor whenever the
  // show is anchored to Navidrome playlist(s). Placed early so playlist tracks
  // fill the pool before the (shrunk) discovery sources. In strict mode the
  // whole pool is filtered to these ids at the end, so this is the universe.
  if (hasPlaylist) {
    take('show-playlist', shuffle(playlistPool!.tracks), strictPlaylist ? SHOW_PLAYLIST_STRICT_WEIGHT : SHOW_PLAYLIST_WEIGHT);
  }

  // 1. Mood-tagged from the LLM-built library (only if tagger has run).
  if (mood) {
    take('mood', enforce(shuffle(preferEnergy(library.songsByMood(mood), showEnergy))), nz(MOOD_WEIGHT));
  }

  // 2. Navidrome playlists whose name matches the mood — operator's hand curation.
  // Skipped when the show already pins its own playlist(s) (0b): mood-substring
  // matching would otherwise leak other shows' same-mood playlists into the
  // fallback pool (#642). Autonomous hours (no pinned playlists) keep it.
  if (mood && !hasPlaylist) {
    try {
      const playlists = await subsonic.getPlaylists();
      const matched = playlists.filter((p: any) => p.name?.toLowerCase().includes(mood.toLowerCase()));
      const tracks: any[] = [];
      for (const pl of matched.slice(0, 2)) {
        try {
          const songs = await subsonic.getPlaylist(pl.id);
          tracks.push(...songs);
        } catch {}
      }
      take('playlist', enforce(shuffle(tracks)), nz(PLAYLIST_WEIGHT));
    } catch (err) {
      queue.log('error', `Playlist fetch failed: ${err.message}`);
    }
  }

  // 3. Recently-added albums — surfaces new music without any tagging.
  try {
    const recentAlbums = await subsonic.getRecentlyAddedAlbums({ size: 8 });
    const tracks = await tracksFromAlbums(shuffle(recentAlbums).slice(0, 4), 2, RECENT_WEIGHT * 2);
    take('recent', enforce(tracks), nz(RECENT_WEIGHT));
  } catch (err) {
    queue.log('error', `Recent-albums fetch failed: ${err.message}`);
  }

  // 4. Frequent albums — Navidrome's scrobble-backed favourites.
  try {
    const freqAlbums = await subsonic.getFrequentAlbums({ size: 8 });
    const tracks = await tracksFromAlbums(shuffle(freqAlbums).slice(0, 4), 2, FREQUENT_WEIGHT * 2);
    take('frequent', enforce(tracks), nz(FREQUENT_WEIGHT));
  } catch (err) {
    queue.log('error', `Frequent-albums fetch failed: ${err.message}`);
  }

  // 5. Starred — hand-curated.
  try {
    const starred = shuffle(await subsonic.getStarred());
    take('starred', enforce(starred), nz(STARRED_WEIGHT));
  } catch (err) {
    queue.log('error', `Starred fetch failed: ${err.message}`);
  }

  // 6. Top up with random to TARGET_POOL. For a show, bias the fill toward its
  // genre/era (Navidrome filters server-side, so it stays pure). A strict
  // playlist show skips this entirely — random can't be playlist-filtered, so
  // better a short looping in-playlist fallback than off-playlist filler (the
  // strict end-filter below would drop it anyway).
  if (pool.length < TARGET_POOL && !strictPlaylist) {
    try {
      const random = narrow
        ? await subsonic.getRandomSongs({ size: TARGET_POOL, genre: genreName || undefined, fromYear: fromYear ?? undefined, toYear: toYear ?? undefined })
        : await subsonic.getRandomSongs({ size: TARGET_POOL });
      take('random', shuffle(random), TARGET_POOL);
    } catch (err) {
      queue.log('error', `Random fetch failed: ${err.message}`);
    }
    // Soft shows: if the genre/era-biased fill couldn't reach TARGET_POOL,
    // never-starve with unfiltered random (variety over purity). Strict shows
    // skip this — better a short, looping in-genre playlist than off-genre filler.
    if (narrow && !strict && pool.length < TARGET_POOL) {
      try {
        take('random', shuffle(await subsonic.getRandomSongs({ size: TARGET_POOL })), TARGET_POOL);
      } catch {}
    }
  }

  // Strict playlist: drop every off-playlist track so the LLM-free coast plays
  // only the show's curation. The dedicated show-playlist source guarantees
  // in-set tracks are present, so this is normally a clean filter; never-starve
  // to the unfiltered pool only if NOT ONE survived (a true dead-air guard).
  if (strictPlaylist) {
    const inPl = pool.filter((t: any) => t?.id && playlistPool!.ids.has(t.id));
    if (inPl.length) { pool.length = 0; pool.push(...inPl); }
  }

  // Excluded playlists (blocklist): drop every track from a blocklisted
  // playlist. The pick paths (picker.ts / picker-tools.ts) apply this as a HARD
  // filter — an empty pool there just skips the LLM pick and coasts on this
  // auto.m3u. This IS that coast, the last dead-air guard, so it mirrors the
  // strict-playlist block above: never-starve if the blocklist would empty the
  // pool (a mis-set "exclude everything" plays an excluded track over silence).
  if (excludedIds) {
    const allowed = pool.filter((t: any) => t?.id && !excludedIds.has(t.id));
    if (allowed.length) { pool.length = 0; pool.push(...allowed); }
  }

  // Stamp the station cap on every fallback entry (#447). max-track-length is a
  // pure on-air cue_out cut, not a selection filter, so over-length tracks stay
  // in the pool and simply crossfade out at the cap when the queue runs dry.
  const lines = ['#EXTM3U', ...pool.map((t: any) => subsonic.getAnnotatedUri(t, { maxDurationSec }))];
  // Atomic replace: Liquidsoap watches this file (reload_mode="watch"), so an
  // in-place write can trigger a reload that loads a truncated playlist.
  await writeFileAtomic(config.liquidsoap.autoPlaylist, lines.join('\n'));

  // Make the show-scoping visible to the operator (acceptance criteria #629):
  // a misspelled / absent strict genre that silently degraded, and a strict show
  // whose genre is too thin to fill the pool, are both worth surfacing.
  if (strict && !genreName) {
    queue.log('scheduler', `Auto-playlist: strict genre "${showGenre}" not found in library — fallback left unfiltered`);
  } else if (strict && genreName && pool.length < TARGET_POOL) {
    queue.log('scheduler', `Auto-playlist: only ${pool.length} in-genre tracks for ${genreName} — looping a short genre-pure fallback`);
  }
  if (strictPlaylist && pool.length < TARGET_POOL) {
    queue.log('scheduler', `Auto-playlist: only ${pool.length} in-playlist tracks — looping a short playlist-pure fallback`);
  }

  const playlistTag = hasPlaylist
    ? (playlistPool!.names.length ? playlistPool!.names.join('/') : `${show.playlistIds.length} playlist(s)`)
    : '';
  const showInfo = show
    ? `, show=${show.name}${strict ? ' filters=strict' : ''}` +
      (showGenre ? ` genre=${genreName || showGenre}` : '') +
      (fromYear != null || toYear != null ? ` year=${fromYear ?? ''}-${toYear ?? ''}` : '') +
      (showEnergy ? ` energy=${showEnergy}` : '') +
      (hasPlaylist ? ` playlist=${playlistTag} (${strictPlaylist ? 'strict' : 'soft'})` : '')
    : '';
  queue.log('scheduler',
    `Auto-playlist refreshed: ${pool.length} tracks (` +
    Object.entries(fromSource).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' ') +
    `, mood=${mood || 'none'}${showInfo})`);
}

// ---------------------------------------------------------------------------
// HOURLY TIME CHECK
// At the top of every hour, the DJ checks in.
// ---------------------------------------------------------------------------

// Gate-free runner — also called directly by the /dj/segment command route as
// an operator override. The cron wrapper below adds the frequency gate.
export async function runHourlyCheck() {
  return withTrace({ kind: 'hourly' }, async () => {
    const ctx = await getFullContext();
    // Guest rotation: on a show with co-hosts the time check may come from a
    // guest. Solo shows get the effective persona — behaviour-identical.
    const speaker = settings.pickOnAirSpeaker();
    const script = await dj.generateHourlyTime({
      recap: queue.getDjRecap(),
      context: ctx,
      recentOpeners: queue.getRecentOpeners(),
      persona: speaker,
    });
    await queue.announce(script, 'hourly-check', {
      persona: speaker, meta: { personaId: speaker?.id, personaName: speaker?.name },
    });
    return script;
  });
}

async function hourlyCheck() {
  // The top of the hour is the natural show boundary — roll the session here
  // so a scheduled show starting/ending opens a fresh chat history even if no
  // track happens to start right on the hour. getFullContext() stays inside the
  // try — node-cron doesn't catch async throws, so an escape here would be an
  // unhandled rejection.
  let ctx: Awaited<ReturnType<typeof getFullContext>> | null = null;
  try {
    ctx = await getFullContext();
    await session.maybeRoll(ctx);
  } catch (err) {
    queue.log('error', `Session roll failed: ${err.message}`);
  }
  // If that roll crossed a persona boundary, air the two-voice mic-pass. It
  // does its own listener/budget gating and marks itself aired, so it's safe to
  // call unconditionally here (whichever of this cron or a track-start rolls the
  // session first drives it — the other no-ops). No ctx → the roll above didn't
  // happen either; leave the handoff pending for the next call site.
  if (ctx) {
    try {
      await djAgent.runPersonaHandoff(queue, ctx);
    } catch (err) {
      queue.log('error', `Persona handoff failed: ${err.message}`);
    }
  }
  if (!shouldFire('hourly')) return;
  if (!djCallsAllowed()) return;  // nobody listening — stay on the auto playlist
  if (!optionalSegmentsAllowed()) return;  // over the daily token budget — mute optional segments
  try {
    await runHourlyCheck();
  } catch (err) {
    queue.log('error', `Hourly check failed: ${err.message}`);
  }
}

// Generate and air a between-track DJ link for whatever is playing now.
// Gate-free; used by the /dj/segment command route.
export async function runLink() {
  return withTrace({ kind: 'link' }, async () => {
    const current = queue.current?.track;
    if (!current) throw new Error('nothing is playing — no track to link from');
    const previous = queue.history[0]?.track || null;
    const ctx = await getFullContext();
    const speaker = settings.pickOnAirSpeaker();
    const script = await dj.generateLink({
      previous,
      current,
      context: ctx,
      recap: queue.getDjRecap(),
      recentTracks: queue.getRecentTracks(),
      recentOpeners: queue.getRecentOpeners(),
      persona: speaker,
    });
    await queue.announce(script, 'link', {
      persona: speaker, meta: { personaId: speaker?.id, personaName: speaker?.name },
    });
    return script;
  });
}

// ---------------------------------------------------------------------------
// BANTER
// A short scripted exchange between the show's host and its guest co-hosts —
// the multi-voice payoff of guest shows. One structured LLM call writes the
// whole exchange; queue.announceExchange renders each line in its speaker's
// own voice and airs them back-to-back through the serialized voice chain.
// ---------------------------------------------------------------------------

// Gate-free runner — also called directly by the /dj/segment command route as
// an operator override (which is why it ignores the show's banter toggle: an
// explicit button press always fires; only the ROSTER is non-negotiable, since
// a one-person exchange can't exist). The cron wrapper below adds the gates.
export async function runBanter() {
  return withTrace({ kind: 'banter' }, async () => {
    const { host, guests, show } = settings.getOnAirRoster();
    if (!host || !guests.length) {
      throw new Error('banter needs a show with guest co-hosts on air');
    }
    const ctx = await getFullContext();
    const lines = await dj.generateBanter({
      host, guests, show,
      current: queue.current?.track || null,
      context: ctx,
      recap: queue.getDjRecap(),
      recentOpeners: queue.getRecentOpeners(),
    });
    if (!lines) throw new Error('banter generation returned no usable exchange');
    const ok = await queue.announceExchange(lines, 'banter');
    if (!ok) throw new Error('banter exchange failed to render');
    return lines.map(l => `${l.persona.name}: ${l.text}`).join('\n');
  });
}

// Minimum quiet gap before an exchange: banter is the longest spoken break we
// air, so it shouldn't pile onto a talk break the listener just heard.
const BANTER_MIN_GAP_MS = 5 * 60_000;

async function banterTick() {
  const { show, guests } = settings.getOnAirRoster();
  if (!show?.banter || !guests.length) return;  // solo show, or banter not opted in
  if (!shouldFire('banter')) return;
  if (!djCallsAllowed()) return;  // nobody listening — save the tokens and the breath
  if (!optionalSegmentsAllowed()) return;  // over the daily token budget — mute optional segments
  // Every standalone talk break counts — idents, hourly, handoff, banter AND
  // the segment-director spots (weather/news/…). Track-tied links don't, or a
  // chatty DJ-mode station would never banter.
  if (Date.now() - queue.getLastTalkBreakAt() < BANTER_MIN_GAP_MS) return;
  try {
    await runBanter();
  } catch (err) {
    queue.log('error', `Banter failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// SEGMENT TICK
// Hands a snapshot of the moment and a set of real-world data tools to the
// segment-director agent (skills/_agent.js), which decides whether to air one
// between-track segment (weather / news / now-playing dig / fact / artist news) or to
// stay silent. The same agent also backs the /dj/skill manual-override route
// (runCapability), forced to one capability.
// ---------------------------------------------------------------------------

async function skillsTick() {
  if (!djCallsAllowed()) return;  // nobody listening — skip the segment director
  if (!optionalSegmentsAllowed()) return;  // over the daily token budget — mute optional segments
  try {
    await withTrace({ kind: 'segment' }, async () => {
      const ctx = await getFullContext();
      await agenticTick(ctx);
    });
  } catch (err) {
    queue.log('error', `Segment tick failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// STATION ID
// Random ident every ~45 mins
// ---------------------------------------------------------------------------

// Gate-free runner — also called directly by the /dj/segment command route
// (immediate: an operator pressing the button wants it NOW). The scheduled
// path passes atNextTrack so the ident holds for the next track boundary
// instead of ducking the current song mid-vocal at an arbitrary wall-clock
// minute — an ident has no real-time constraint, so the wait is free.
export async function runStationId({ atNextTrack = false } = {}) {
  return withTrace({ kind: 'station-id' }, async () => {
    const ctx = await getFullContext();
    const speaker = settings.pickOnAirSpeaker();
    const script = await dj.generateStationId({
      recap: queue.getDjRecap(),
      context: ctx,
      recentOpeners: queue.getRecentOpeners(),
      persona: speaker,
    });
    const opts = { persona: speaker, meta: { personaId: speaker?.id, personaName: speaker?.name } };
    if (atNextTrack) await queue.announceAtNextTrack(script, 'station-id', opts);
    else await queue.announce(script, 'station-id', opts);
    return script;
  });
}

async function stationId() {
  if (!shouldFire('stationId')) return;
  if (!djCallsAllowed()) return;  // nobody listening — skip the ident
  if (!optionalSegmentsAllowed()) return;  // over the daily token budget — mute optional segments
  try {
    await runStationId({ atNextTrack: true });
  } catch (err) {
    queue.log('error', `Station ID failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// CLEAN UP — old voice WAVs + library DB WAL
// ---------------------------------------------------------------------------

async function cleanup() {
  try {
    await cleanupOldVoices();
  } catch (err) {
    queue.log('error', `Cleanup failed: ${err.message}`);
  }
  // Fold the library DB's WAL sidecar back into the main file. Without a
  // periodic TRUNCATE checkpoint a bulk write pass (tagging, acoustic
  // analysis) leaves the WAL at its high-water mark — 730MB in #786 — and
  // every query afterwards pays to walk it.
  try {
    library.checkpoint();
  } catch (err) {
    queue.log('error', `Library WAL checkpoint failed: ${err.message}`);
  }
  // Drop event day-files past the retention horizon — the JSONL timeline
  // rotates daily but nothing ever deleted old days.
  try {
    const removed = await pruneOldEvents();
    if (removed) queue.log('scheduler', `Cleanup: pruned ${removed} old event log file(s)`);
  } catch (err) {
    queue.log('error', `Event log prune failed: ${err.message}`);
  }
  // Archive retention — delete hourly recordings older than the operator's
  // window. 0 (the default) keeps everything, matching prior behaviour.
  try {
    const days = settings.get().archive?.retentionDays || 0;
    if (days > 0) {
      const { removed, bytes } = await archives.pruneOlderThan(days);
      if (removed) {
        queue.log('scheduler',
          `Archive retention: removed ${removed} recording(s) older than ${days}d (${Math.round(bytes / 1_000_000)} MB freed)`);
      }
    }
  } catch (err) {
    queue.log('error', `Archive retention failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// NIGHTLY HEALTH CHECK
// Run the deterministic doctor assessment once a day so the admin header badge
// and the DJ Doc panel reflect the station's health even before the operator
// opens it. No LLM call — runDoctor is LLM-free; the result is just cached.
// ---------------------------------------------------------------------------

async function nightlyDoctor() {
  try {
    await withTrace({ kind: 'doctor' }, () => doctor.runDoctor());
  } catch (err) {
    queue.log('error', `Nightly health check failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------

export function startScheduler() {
  // Initial run
  refreshAutoPlaylist().catch(err => queue.log('error', `Initial playlist failed: ${err.message}`));

  // Auto-playlist refresh every 10 minutes
  cron.schedule(`*/${config.show.autoQueueRefreshMinutes} * * * *`, refreshAutoPlaylist);

  // Top of every hour
  cron.schedule('0 * * * *', hourlyCheck);

  // Segment tick every 5 minutes — the segment-director agent decides whether
  // to air a segment; per-kind cooldowns and the frequency floor live in it.
  cron.schedule('*/5 * * * *', skillsTick);

  // Station ID candidate ticks at :15, :30, :45 — handler gates by frequency.
  // Deliberately NOT :00: the hourly check owns the top of the hour, and firing
  // both there stacked two voice segments on each other (issue #310).
  cron.schedule('15,30,45 * * * *', stationId);

  // Guest-show banter at :20/:50 — minutes no other wall-clock talker owns
  // (same issue-#310 reasoning as the ident slots). The handler gates on the
  // show's banter toggle, the live roster, frequency, listeners and budget.
  cron.schedule('20,50 * * * *', banterTick);

  // Cleanup every hour
  cron.schedule('0 * * * *', cleanup);

  // Nightly health check at 04:17 — populates the DJ Doc last-run cache + header
  // badge without the operator having to open the panel. Deterministic (no LLM).
  cron.schedule('17 4 * * *', nightlyDoctor);

  queue.log('scheduler', `Scheduler started · skills: ${skillCatalog().map((s: any) => s.name).join(', ')}`);
}
