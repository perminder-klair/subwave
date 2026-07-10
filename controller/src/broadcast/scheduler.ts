// Scheduler — drives autonomous behaviour:
//   - refreshes the auto-playlist file Liquidsoap falls back to
//   - hourly time check (top of every hour, in character)
//   - station IDs (every ~45 min, varied by frequency setting)
//   - agentic segment tick (weather, news, now-playing digs, facts, web search) every 5 min

import cron from 'node-cron';
import { config } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import { shuffle } from '../util/shuffle.js';
import * as subsonic from '../music/subsonic.js';
import * as dj from '../llm/dj.js';
import * as library from '../music/library.js';
import * as settings from '../settings.js';
import { normGenre, genreMatches, inYearRange, preferEnergy, preferEnergyStrict, preferMood, hasEraBound, eraSpan } from '../music/show-filter.js';
import { resolveShowPlaylistPool, resolveExcludedPlaylistIds } from '../music/show-playlist.js';
import { getFullContext } from '../context.js';
import { queue } from './queue.js';
import { createPoolBuilder } from './auto-pool.js';
import { reloadAutoPlaylist } from './liquidsoap-control.js';
import * as session from './session.js';
import * as djAgent from './dj-agent.js';
import * as programme from './programme.js';
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
  // Match the auto-DJ picker's window (dj-agent.pickViaAgent) — 12h. Keyed by
  // BOTH id and lowercased `title|artist`: a library with duplicate copies of a
  // song holds N Subsonic ids for it, so an id-only recency filter lets copies
  // #2..N sail into the fallback and re-air a just-played track (issue #874).
  // Mirrors collect() in the picker's tool layer.
  const { ids: recentIds, keys: recentKeys } = queue.recentlyPlayed(12);

  // The fallback is what airs when the live AI picks pause (e.g. pause-when-empty
  // with zero listeners). When a show is scheduled for this hour, the fallback
  // should stay on-brand exactly as the picker does — so we steer the pool by the
  // active show's genre / era / energy, mirroring music/picker.ts (issue #629).
  const show: any = settings.resolveActiveShow();
  // Multi-value lists (#929): OR within an attribute, AND across attributes.
  const showGenres: string[] = show?.genres ?? [];
  const eras = (show?.eras ?? []) as { fromYear: number | null; toYear: number | null }[];
  const showEnergies: string[] = show?.energies ?? [];
  // A genre or a year window narrows the pool; energy alone only soft-leans
  // (mirrors picker.hasMusicFilter). Strict (show.filtersStrict) opts EVERY set
  // filter — mood, genre, era, energy — into a hard filter on the pool.
  const narrow = !!(show && (showGenres.length || hasEraBound(eras)));
  const showMoods: string[] = show?.moods ?? [];
  const strict = !!(show?.filtersStrict && (showGenres.length || showMoods.length || showEnergies.length || hasEraBound(eras)));

  // Show playlist anchor: resolve the union once. The fallback must honour it
  // too, so the LLM-free coast (LLM down, budget-hard, zero listeners) still
  // plays the show's playlist. Strict → the pool is hard-filtered to it at the
  // end (and the off-playlist random top-up is skipped); soft → it just
  // dominates. Null when the show pins no playlists.
  const playlistPool = show ? await resolveShowPlaylistPool(show) : null;
  const hasPlaylist = !!playlistPool?.tracks?.length;
  const strictPlaylist = hasPlaylist && !!show?.playlistStrict;
  const excludedIds = show ? await resolveExcludedPlaylistIds(show) : null;

  // Resolve the show's free-text genres to the library's exact tags once, up
  // front. Entries that fail to resolve drop out; NONE resolving disables the
  // strict hard-filter and the genre-targeted fetches — the documented degrade
  // path (a misspelled / library-absent genre falls back to the normal pool).
  const genreNames: string[] = [];
  for (const g of showGenres) {
    try {
      const resolved = await subsonic.resolveGenreName(g);
      if (resolved) genreNames.push(resolved);
    } catch {}
  }
  const strictGenreNorms = strict ? genreNames.map(normGenre).filter(Boolean) : [];
  // Strict: hard-drop off-genre / off-era tracks from every discovery source
  // (even if that empties the source) — the auto playlist airs in full with no
  // LLM gatekeeper, so never-starve off-target filler would actually play. The
  // dedicated genre source + genre/era-targeted random carry the pool; an
  // unresolved genre list disables the genre drop (no resolved names → no filter).
  // Mood and energy enforce with per-source never-starve instead (preferMood /
  // preferEnergyStrict): they depend on the tagger/analyzer having run, and an
  // un-tagged library hard-dropping everything would empty the dead-air
  // fallback entirely. Soft mode is a no-op here.
  const enforce = (items: any[]) => {
    let out = items;
    if (strictGenreNorms.length) out = out.filter((t: any) => genreMatches(t, strictGenreNorms));
    if (strict && hasEraBound(eras)) out = inYearRange(out, eras);
    if (strict && showMoods.length) out = preferMood(out, showMoods);
    if (strict && showEnergies.length) out = preferEnergyStrict(out, showEnergies);
    return out;
  };
  // Shrink the off-genre / off-playlist sources so the dedicated show source
  // (genre or playlist) dominates the pool.
  const nz = (cap: number) => ((narrow || hasPlaylist) ? Math.max(2, Math.ceil(cap * SHOW_NARROW_FACTOR)) : cap);

  // Length cap: the active show's override or the station default (issue #447),
  // resolved in seconds. null = no cap. Now that the fallback honours the show's
  // genre/era it honours its track-length cap too.
  const maxDurationSec = settings.effectiveMaxTrackSec(show);

  // Balanced pool builder — applies the recency / dedup / artist-cap guards on
  // every candidate. Recency and dedup key on BOTH id and `title|artist` so a
  // library with duplicate copies of a song (N distinct ids for one track)
  // can't slip a just-played track back in or stack copies into the pool (#874).
  // The artist cap stops a deep-catalogue artist from dominating the fallback.
  // Pure + unit-tested in scripts/auto-pool.test.ts.
  const builder = createPoolBuilder({
    recentIds,
    recentKeys,
    targetPool: TARGET_POOL,
    maxPerArtist: AUTO_MAX_PER_ARTIST,
  });
  const pool = builder.pool;
  const fromSource = builder.fromSource;
  const take = builder.take;

  await library.load();

  // 0. Dedicated show-genre / era source — the dominant contributor whenever a
  // show pins a genre or a year window. Both Navidrome queries filter server-side,
  // so this source is inherently genre/era-pure (no never-starve pollution). Soft
  // energy lean on top. Placed first so genre-native tracks fill the pool before
  // the (shrunk) discovery sources add variety.
  if (narrow) {
    try {
      // getRandomSongs takes ONE genre + ONE contiguous range natively, so
      // multiple values (#929) call per genre against the eras' coarse
      // envelope (eraSpan); the genre-tagged sets post-filter to the exact
      // window union (inYearRange).
      const span = eraSpan(eras);
      const collected: any[] = [];
      const randomSize = strict ? 60 : 40;
      const genreSetSize = strict ? 100 : 60;
      for (const genreName of genreNames.length ? genreNames : [undefined]) {
        collected.push(...await subsonic.getRandomSongs({
          size: Math.ceil(randomSize / Math.max(1, genreNames.length)),
          genre: genreName,
          fromYear: span.fromYear ?? undefined,
          toYear: span.toYear ?? undefined,
        }));
        if (genreName) {
          const g = await subsonic.getSongsByGenre(genreName, { count: Math.ceil(genreSetSize / genreNames.length) });
          const ranged = inYearRange(g, eras);
          collected.push(...(ranged.length ? ranged : g));
        }
      }
      // The random fetch used the coarse era envelope — tighten to the exact
      // union (never-starve to the envelope set when the union comes up empty).
      const exact = hasEraBound(eras) ? inYearRange(collected, eras) : collected;
      // Genre/era are server-side native here; enforce() adds the strict
      // mood/energy filters on top (no-op in soft mode).
      const leaned = enforce(preferEnergy(exact.length ? exact : collected, showEnergies));
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

  // 1. Mood-tagged from the LLM-built library (only if tagger has run). A
  // multi-mood show pools ALL its moods equally (#929); autonomous hours keep
  // the single dominantMood. Dedup by id across the unioned mood sets.
  const poolMoods = showMoods.length ? showMoods : (mood ? [mood] : []);
  if (poolMoods.length) {
    const seenMoodIds = new Set<string>();
    const moodPool: any[] = [];
    for (const m of poolMoods) {
      for (const t of library.songsByMood(m)) {
        if (t?.id && seenMoodIds.has(t.id)) continue;
        if (t?.id) seenMoodIds.add(t.id);
        moodPool.push(t);
      }
    }
    take('mood', enforce(shuffle(preferEnergy(moodPool, showEnergies))), nz(MOOD_WEIGHT));
  }

  // 2. Navidrome playlists whose name matches the mood — operator's hand curation.
  // Skipped when the show already pins its own playlist(s) (0b): mood-substring
  // matching would otherwise leak other shows' same-mood playlists into the
  // fallback pool (#642). Autonomous hours (no pinned playlists) keep it.
  if (poolMoods.length && !hasPlaylist) {
    try {
      const playlists = await subsonic.getPlaylists();
      const matched = playlists.filter((p: any) =>
        poolMoods.some(m => p.name?.toLowerCase().includes(m.toLowerCase())));
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
      let random: any[];
      if (narrow) {
        // Same per-genre split + coarse era envelope as the dedicated source.
        const span = eraSpan(eras);
        random = [];
        for (const genreName of genreNames.length ? genreNames : [undefined]) {
          random.push(...await subsonic.getRandomSongs({
            size: Math.ceil(TARGET_POOL / Math.max(1, genreNames.length)),
            genre: genreName,
            fromYear: span.fromYear ?? undefined,
            toYear: span.toYear ?? undefined,
          }));
        }
        const exact = hasEraBound(eras) ? inYearRange(random, eras) : random;
        random = exact.length ? exact : random;
      } else {
        random = await subsonic.getRandomSongs({ size: TARGET_POOL });
      }
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
  // Deterministic reload: don't trust Liquidsoap's inotify watch. The atomic
  // rename above swaps the file's inode, and if the watch ever orphans itself
  // the fallback loops the last-loaded ~30-track snapshot forever until the
  // container restarts (issue #874). Telnet `auto.reload` forces a re-read every
  // time; best-effort so an unreachable mixer (dev / mid-restart) never fails
  // the refresh — the watch remains as a backstop.
  const reloaded = await reloadAutoPlaylist();
  if (!reloaded) queue.log('scheduler', 'Auto-playlist written but telnet reload failed — relying on inotify watch');

  // Make the show-scoping visible to the operator (acceptance criteria #629):
  // a misspelled / absent strict genre that silently degraded, and a strict show
  // whose genre is too thin to fill the pool, are both worth surfacing.
  if (strict && showGenres.length && !genreNames.length) {
    queue.log('scheduler', `Auto-playlist: strict genre(s) "${showGenres.join(', ')}" not found in library — fallback left unfiltered`);
  } else if (strict && genreNames.length && pool.length < TARGET_POOL) {
    queue.log('scheduler', `Auto-playlist: only ${pool.length} in-genre tracks for ${genreNames.join(', ')} — looping a short genre-pure fallback`);
  }
  if (strictPlaylist && pool.length < TARGET_POOL) {
    queue.log('scheduler', `Auto-playlist: only ${pool.length} in-playlist tracks — looping a short playlist-pure fallback`);
  }

  const playlistTag = hasPlaylist
    ? (playlistPool!.names.length ? playlistPool!.names.join('/') : `${show.playlistIds.length} playlist(s)`)
    : '';
  const eraTag = eras
    .filter(e => e.fromYear != null || e.toYear != null)
    .map(e => `${e.fromYear ?? ''}-${e.toYear ?? ''}`)
    .join(',');
  const showInfo = show
    ? `, show=${show.name}${strict ? ' filters=strict' : ''}` +
      (showGenres.length ? ` genre=${(genreNames.length ? genreNames : showGenres).join(',')}` : '') +
      (eraTag ? ` year=${eraTag}` : '') +
      (showEnergies.length ? ` energy=${showEnergies.join(',')}` : '') +
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
    // Plan the episode BEFORE the mic-pass so a persona handoff into a
    // programme show can weave the episode angle into the greeting (the
    // greeting doubles as the show's intro on a persona-change boundary).
    try {
      await programme.ensurePlan(ctx);
    } catch (err) {
      queue.log('error', `Programme plan failed: ${err.message}`);
    }
    try {
      await djAgent.runPersonaHandoff(queue, ctx);
    } catch (err) {
      queue.log('error', `Persona handoff failed: ${err.message}`);
    }
    // Programme shows: open the episode. The intro owns the top of the show's
    // first hour, so when it airs (now, or minutes ago via the track-start
    // call site, or as the handoff greeting above) the generic time check
    // stands down — the same one-talker-per-slot rule as issue #310.
    try {
      const introAired = await programme.onSessionSettled(queue, ctx);
      if (introAired || programme.suppressHourly()) return;
    } catch (err) {
      queue.log('error', `Programme episode hook failed: ${err.message}`);
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
      // Unlike a pick-attached link, this one airs right now (announce below),
      // so the live clock in ctx is the air time — the model may speak it.
      clockIsAirTime: true,
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
  if (programme.onAir()) return;  // a programme episode owns its talk moments — the director stands down
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
// PROGRAMME BEATS
// The feature beat mid-hour (station-minute :35–:39) and the outro in the
// closing minutes of the final hour (station-minute :55+). Placement is a
// STATION-clock fact, but station zones sit at :30/:45 offsets (IST, Nepal),
// so fixed process-minute crons can land mid-show — the tick runs every 5
// minutes and dispatches on programme.dueBeat() instead; the beat flags make
// the repeat ticks inside a window no-ops. The intro has no cron of its own:
// it rides the session-settled hook (hourlyCheck above + queue's track-start
// path). Gating (listeners, budget, beat-already-aired) lives in programme.ts.
// ---------------------------------------------------------------------------

async function programmeTick() {
  if (!programme.onAir()) return;
  const beat = programme.dueBeat();
  if (!beat) return;
  try {
    const ctx = await getFullContext();
    if (beat === 'feature') await programme.featureTick(queue, ctx);
    else await programme.outroTick(queue, ctx);
  } catch (err) {
    queue.log('error', `Programme ${beat} tick failed: ${err.message}`);
  }
}

// Gate-free manual runners — the /dj/segment command route. An operator press
// always fires (only "no programme show on air" throws). Intro/outro re-mark
// their beat so the autonomous path doesn't re-open or re-close the show; a
// manual feature deliberately doesn't consume the hour's planned beat.
export async function runProgrammeIntro() {
  const ctx = await getFullContext();
  await session.maybeRoll(ctx);
  await programme.ensurePlan(ctx);
  const out = await programme.runIntro(queue, ctx);
  programme.markIntroAired();
  return out;
}

export async function runProgrammeFeature() {
  const ctx = await getFullContext();
  await session.maybeRoll(ctx);
  await programme.ensurePlan(ctx);
  return programme.runFeature(queue, ctx);
}

export async function runProgrammeOutro() {
  const ctx = await getFullContext();
  await session.maybeRoll(ctx);
  await programme.ensurePlan(ctx);
  const out = await programme.runOutro(queue, ctx);
  session.markProgrammeBeat('outro');
  return out;
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

  // Programme beats: feature mid-hour, outro in the final minutes of the
  // show's last hour — dispatched on STATION-zone minute windows (see
  // programmeTick). No-ops outside a programme episode.
  cron.schedule('*/5 * * * *', programmeTick);

  // Cleanup every hour
  cron.schedule('0 * * * *', cleanup);

  // Nightly health check at 04:17 — populates the DJ Doc last-run cache + header
  // badge without the operator having to open the panel. Deterministic (no LLM).
  cron.schedule('17 4 * * *', nightlyDoctor);

  queue.log('scheduler', `Scheduler started · skills: ${skillCatalog().map((s: any) => s.name).join(', ')}`);
}
