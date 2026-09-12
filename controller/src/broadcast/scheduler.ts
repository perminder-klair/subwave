// Scheduler: the auto-playlist refresh, the per-minute talk tick over
// talk-scheduler.ts's slot table (every spoken segment the station produces on
// its own, plus the unconditional :00 session roll), and the maintenance crons.

import cron, { type ScheduledTask } from 'node-cron';
import { config } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import { shuffle } from '../util/shuffle.js';
import { mapPool } from '../util/async-pool.js';
import * as subsonic from '../music/source.js';
import * as silenceTrim from '../music/silence-trim.js';
import * as dj from '../llm/dj.js';
import * as library from '../music/library.js';
import * as settings from '../settings.js';
import { jingleRotateOwner, rotateJingleDue } from './jingle-rotate.js';
import { normGenre, genreMatches, genreResolutionWarningOnce, inYearRange, preferEnergy, preferEnergyStrict, preferMood, applyStrictLocks, hasEraBound, eraSpan, type VocalMode } from '../music/show-filter.js';
import { freshnessBiasedOrder } from '../music/airing.js';
import { recencyWindowsForLibrary } from '../music/recency.js';
import { resolveShowPlaylistPool, resolveExcludedPlaylistIds } from '../music/show-playlist.js';
import { getFullContext } from '../context.js';
import { queue } from './queue.js';
import { createPoolBuilder } from './auto-pool.js';
import { applyTrackFloor } from '../music/track-floor.js';
import { autoPlaylistShowLabel, createShowBuildTracker } from './auto-playlist-show.js';
import { reloadAutoPlaylist } from './liquidsoap-control.js';
import * as session from './session.js';
import * as djAgent from './dj-agent.js';
import * as programme from './programme.js';
import { cleanupOldVoices } from '../audio/tts.js';
import { cleanupPauseTalkSilence } from '../audio/wav-silence.js';
import { warmHeavy } from '../audio/ttsHeavyClient.js';
import { shouldFire } from './dj-gate.js';
import { speakClockAllowed, stationIdDaypartStamp } from './clock-policy.js';
import { talkOnlyBetweenTracks, withTalkAir } from './talk-air.js';
import { talkTickPlan, type TalkKind, type TalkPlan } from './talk-scheduler.js';
import { djCallsAllowed } from './listeners.js';
import { autoVoiceAllowed } from './voice-policy.js';
import { optionalSegmentsAllowed } from './dj-budget.js';
import { agenticTick, skillCatalog, runCapability } from '../skills/_agent.js';
import { loadedCapabilities } from '../skills/loader.js';
import { skillEligible } from '../skills/eligibility.js';
import { getStationTimezone, onStationTimezoneChange } from '../time.js';
import { withTrace, pruneOldEvents } from '../observability/events.js';
import * as archives from './archives.js';
import * as stemCacheStore from '../music/stem-cache.js';
import * as stemBlendStore from './stem-blend.js';
import * as doctor from '../doctor.js';
import * as backup from '../backup/scheduled.js';

// take() hard-stops at the target, so TARGET_POOL must exceed the sum of the
// non-show weights or the random top-up below becomes unreachable.
const TARGET_POOL = 40;
const MOOD_WEIGHT = 12;          // up to this many mood-tagged tracks per pool
const PLAYLIST_WEIGHT = 6;       // mood-matched Navidrome playlists
const EXPLORE_WEIGHT = 8;        // reserved library-wide random / unaired slot
const RECENT_WEIGHT = 4;         // recently-added albums
const FREQUENT_WEIGHT = 4;       // frequent / scrobble-favourite albums
const STARRED_WEIGHT = 6;        // hand-starred tracks
const AUTO_MAX_PER_ARTIST = 2;   // cap any one artist's share of the fallback pool
// A show pinning a genre/era or a playlist gets a dedicated dominant source;
// the off-genre sources shrink by SHOW_NARROW_FACTOR (#629). Keep these scaled
// with TARGET_POOL so a show's share of the pool stays ~constant.
const SHOW_GENRE_WEIGHT = 18;        // dedicated show-genre source (soft lean)
const SHOW_GENRE_STRICT_WEIGHT = 32; // strict: this source carries most of the pool
const SHOW_PLAYLIST_WEIGHT = 18;        // dedicated show-playlist source (soft)
const SHOW_PLAYLIST_STRICT_WEIGHT = 32; // strict: this source carries the pool
const SHOW_NARROW_FACTOR = 0.5;      // shrink mood/playlist/recent/etc. for shows
// In-flight Navidrome queries for the show-genre fan-out. Small on purpose;
// matches music/picker.ts.
const SHOW_GENRE_FETCH_CONCURRENCY = 4;

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

// Writes an M3U with mood-appropriate tracks for Liquidsoap's fallback source.
export async function refreshAutoPlaylist() {
  return withTrace({ kind: 'auto-playlist' }, () => refreshAutoPlaylistInner());
}

// Which show the file on disk holds (#1111); rules in auto-playlist-show.ts.
const autoPlaylistBuild = createShowBuildTracker();

// Rebuild the fallback only when the resolved active show is not the one
// auto.m3u holds. Called from rollSessionNow, the shared boundary sequence
// every show transition runs through — never a second cron. Returns whether it
// rebuilt.
export async function refreshAutoPlaylistOnShowChange(reason: string): Promise<boolean> {
  const show: any = settings.resolveActiveShow();
  if (!autoPlaylistBuild.needsRebuild(show)) return false;
  const rollback = autoPlaylistBuild.claim(show);
  queue.log('scheduler',
    `Auto-playlist: active show changed to ${autoPlaylistShowLabel(show)} (${reason}) — rebuilding the fallback`);
  try {
    await refreshAutoPlaylist();
  } catch (err: any) {
    rollback();  // still stale — the next boundary must retry
    throw err;
  }
  return true;
}

async function refreshAutoPlaylistInner() {
  // A live-transport source (Spotify) has no request URIs to write into
  // auto.m3u — the transport's own pool fallback plays that role. Building the
  // file would only ask the facade for a URI it refuses to make.
  if (subsonic.activeCapabilities().hasLiveTransport) return;
  const ctx = await getFullContext();
  const mood = ctx.dominantMood;
  // Same library-scaled recency window as the live picker, keyed by BOTH id and
  // lowercased `title|artist` — an id-only filter lets duplicate copies of a
  // just-played song back in (#874).
  await library.load();
  const libStats = library.stats();
  // mirrorTotal, not `total` (tagged only), so an untagged 50k catalogue does
  // not read as empty.
  const windows = recencyWindowsForLibrary(libStats.distinctArtists, libStats.mirrorTotal || libStats.total);
  const { ids: recentIds, keys: recentKeys } = queue.recentlyPlayed(windows.trackHours);

  // The fallback steers by the active show's genre/era/energy, mirroring
  // music/picker.ts (#629).
  const show: any = settings.resolveActiveShow();
  // Multi-value lists (#929): OR within an attribute, AND across attributes.
  const showGenres: string[] = show?.genres ?? [];
  const eras = (show?.eras ?? []) as { fromYear: number | null; toYear: number | null }[];
  const showEnergies: string[] = show?.energies ?? [];
  // A genre or a year window narrows the pool; energy or vocals alone only
  // soft-leans (mirrors picker.hasMusicFilter). Strict opts every set filter
  // into a hard filter.
  const narrow = !!(show && (showGenres.length || hasEraBound(eras)));
  const showMoods: string[] = show?.moods ?? [];
  const showVocals = (show?.vocals ?? '') as VocalMode;
  const strict = !!(show?.filtersStrict && (showGenres.length || showMoods.length || showEnergies.length || showVocals || hasEraBound(eras)));

  // Show playlist anchor, resolved once. Strict → the pool is hard-filtered to
  // it at the end and the off-playlist random top-up is skipped; soft → it just
  // dominates. Null when the show pins no playlists.
  const playlistPool = show ? await resolveShowPlaylistPool(show) : null;
  const hasPlaylist = !!playlistPool?.tracks?.length;
  const strictPlaylist = hasPlaylist && !!show?.playlistStrict;
  const excludedIds = show ? await resolveExcludedPlaylistIds(show) : null;
  // Pinned anchor resolved to nothing → silently un-anchored; surface it.
  if (show?.playlistIds?.length && !playlistPool) {
    queue.log('picker', `show "${show.name}" pins ${show.playlistIds.length} playlist(s) but none resolved to tracks — auto-playlist anchor ignored. Stale playlist id (deleted/recreated in Navidrome?) or a Navidrome error; re-select the playlists in the show editor.`);
  }

  // Resolve the show's free-text genres to the library's exact tags. Entries
  // that fail to resolve drop out; none resolving disables the strict
  // hard-filter and the genre-targeted fetches (degrade to the normal pool).
  const genreNames: string[] = [];
  for (const g of showGenres) {
    try {
      const resolved = await subsonic.resolveGenreName(g);
      const warning = genreResolutionWarningOnce(g, resolved);
      if (warning) queue.log('scheduler', `Show "${show?.name ?? 'auto'}": ${warning}`);
      if (resolved) genreNames.push(resolved);
    } catch {}
  }
  const strictGenreNorms = strict ? genreNames.map(normGenre).filter(Boolean) : [];
  // Strict: hard-drop off-genre/off-era tracks per source, even if that empties
  // the source — this playlist airs with no LLM gatekeeper. Mood and energy use
  // per-source never-starve instead, since an untagged library would otherwise
  // drop everything. No-op in soft mode.
  const enforce = (items: any[]) => {
    let out = items;
    if (strictGenreNorms.length) out = out.filter((t: any) => genreMatches(t, strictGenreNorms));
    if (strict && hasEraBound(eras)) out = inYearRange(out, eras);
    if (strict && showMoods.length) out = preferMood(out, showMoods);
    if (strict && showEnergies.length) out = preferEnergyStrict(out, showEnergies);
    return out;
  };
  // Shrink the off-genre/off-playlist sources so the dedicated show source
  // dominates the pool.
  const nz = (cap: number) => ((narrow || hasPlaylist) ? Math.max(2, Math.ceil(cap * SHOW_NARROW_FACTOR)) : cap);

  // Length cap in seconds, show override or station default (#447). null = no cap.
  const maxDurationSec = settings.effectiveMaxTrackSec(show);
  // Minimum track length (#1573) is a SELECTION filter, not a cue_out cut like
  // the cap: applied to the assembled pool below, never-starve.
  const minDurationSec = settings.effectiveMinTrackSec(show);

  // Balanced pool builder — recency/dedup/artist-cap guards on every candidate,
  // keyed on both id and `title|artist` (#874). Pure; scripts/auto-pool.test.ts.
  const builder = createPoolBuilder({
    recentIds,
    recentKeys,
    targetPool: TARGET_POOL,
    maxPerArtist: AUTO_MAX_PER_ARTIST,
  });
  const pool = builder.pool;
  const fromSource = builder.fromSource;
  const take = builder.take;
  // Replace the pool in place, aliasing-safe: a never-starve filter that hands
  // its input back would otherwise be cleared by `pool.length = 0`, emptying
  // the coast.
  const replacePool = (next: typeof pool) => {
    if (next === pool) return;
    pool.length = 0;
    pool.push(...next);
  };

  // 0. Dedicated show-genre/era source, the dominant contributor when a show
  // pins a genre or year window. Both Navidrome queries filter server-side, so
  // this source is genre/era-pure. Placed first so genre-native tracks fill the
  // pool before the shrunk discovery sources.
  if (narrow) {
    try {
      // getRandomSongs takes ONE genre + ONE contiguous range, so multi-value
      // shows (#929) call per genre against the eras' coarse envelope and
      // post-filter to the exact window union.
      const span = eraSpan(eras);
      const randomSize = strict ? 60 : 40;
      const genreSetSize = strict ? 100 : 60;
      // Two fetches per genre, bounded fan-out; size budgets divide so the
      // collected total stays flat. Mirrors music/picker.ts §1e — keep in step.
      const targets: (string | undefined)[] = genreNames.length ? genreNames : [undefined];
      const perGenre = await mapPool(targets, SHOW_GENRE_FETCH_CONCURRENCY, async (genreName) => {
        const got: any[] = [];
        got.push(...await subsonic.getRandomSongs({
          size: Math.ceil(randomSize / Math.max(1, genreNames.length)),
          genre: genreName,
          fromYear: span.fromYear ?? undefined,
          toYear: span.toYear ?? undefined,
        }));
        if (genreName) {
          // Sampled: a random page of the genre, not the same server-ordered
          // head every refresh.
          const g = await subsonic.getSongsByGenreSampled(genreName, { count: Math.ceil(genreSetSize / genreNames.length) });
          const ranged = inYearRange(g, eras);
          got.push(...(ranged.length ? ranged : g));
        }
        return got;
      });
      const collected: any[] = perGenre.flat();
      // Tighten the coarse envelope to the exact union; never-starve back to
      // the envelope set when the union comes up empty.
      const exact = hasEraBound(eras) ? inYearRange(collected, eras) : collected;
      const leaned = enforce(preferEnergy(exact.length ? exact : collected, showEnergies));
      // neverStarve: the coast's only in-genre contributor.
      take('show-genre', shuffle(leaned), strict ? SHOW_GENRE_STRICT_WEIGHT : SHOW_GENRE_WEIGHT, { neverStarve: true });
    } catch (err) {
      queue.log('error', `Show-genre fetch failed: ${err.message}`);
    }
  }

  // 0b. Dedicated show-playlist source, dominant when the show is anchored to
  // Navidrome playlist(s). In strict mode the whole pool is filtered to these
  // ids at the end, so this is the universe — hence neverStarve, and
  // maxPerArtist lifted for THIS source only (a single-artist pinned playlist
  // is the point; lifting it on the builder would let an uncapped show-genre
  // source fill TARGET_POOL with tracks the end-filter then drops).
  if (hasPlaylist) {
    take('show-playlist', shuffle(playlistPool!.tracks), strictPlaylist ? SHOW_PLAYLIST_STRICT_WEIGHT : SHOW_PLAYLIST_WEIGHT, { neverStarve: true, maxPerArtist: strictPlaylist ? Infinity : AUTO_MAX_PER_ARTIST });
  }

  // 1. Mood-tagged from the LLM-built library (only if the tagger has run). A
  // multi-mood show pools all its moods equally (#929); autonomous hours keep
  // the single dominantMood.
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

  // 2. Navidrome playlists whose name matches the mood. Skipped when the show
  // pins its own playlists (0b) — mood-substring matching would leak other
  // shows' same-mood playlists into the pool (#642).
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

  // 2b. Exploration slot — a reserved library-wide draw, freshness-ordered so
  // never-aired tracks lead. Skipped for a strict playlist show (random can't
  // be playlist-filtered).
  if (!strictPlaylist) {
    try {
      const wide = await subsonic.getRandomSongs({ size: EXPLORE_WEIGHT * 3 });
      take('explore', enforce(freshnessBiasedOrder(wide, library.lastAiredInfo(), Date.now())), nz(EXPLORE_WEIGHT));
    } catch (err) {
      queue.log('error', `Explore fetch failed: ${err.message}`);
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

  // 4. Frequent albums. The window rotates (offset 0/8/16 per refresh) because
  // the counts are fed by the station's own plays, so a fixed top-8 is a
  // positive-feedback loop. An empty deep window falls back to the top.
  try {
    const freqOffset = Math.floor(Math.random() * 3) * 8;
    let freqAlbums = await subsonic.getFrequentAlbums({ size: 8, offset: freqOffset });
    if (!freqAlbums.length && freqOffset > 0) freqAlbums = await subsonic.getFrequentAlbums({ size: 8 });
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

  // 6. Top up with random to TARGET_POOL, biased to the show's genre/era. A
  // strict playlist show skips this — random can't be playlist-filtered.
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
    // Soft shows never-starve with unfiltered random; strict shows would rather
    // loop a short in-genre playlist.
    if (narrow && !strict && pool.length < TARGET_POOL) {
      try {
        take('random', shuffle(await subsonic.getRandomSongs({ size: TARGET_POOL })), TARGET_POOL);
      } catch {}
    }
  }

  // Strict playlist: drop every off-playlist track, but never-starve to the
  // unfiltered pool if not one survived (dead-air guard).
  if (strictPlaylist) {
    const inPl = pool.filter((t: any) => t?.id && playlistPool!.ids.has(t.id));
    if (inPl.length) replacePool(inPl);
  }

  // Strict music filters on the FINAL pool: enforce() only hard-drops
  // genre/era per source, so mood/energy have to be re-applied here the way
  // music/picker.ts does — per-dimension never-starve, so one zero-coverage
  // dimension can't throw away the rest.
  if (strict) {
    const filtered = applyStrictLocks(pool, {
      genres: genreNames,   // resolved library tags ([] → no genre step)
      eras,
      moods: showMoods,
      energies: showEnergies,
      vocals: showVocals,
    }, { starve: false });
    replacePool(filtered);
  }

  // Minimum track length, never-starve: this coast is the last dead-air guard,
  // so a floor that would empty the pool is skipped. 0/null leaves it untouched.
  if (minDurationSec) replacePool(applyTrackFloor(pool, minDurationSec, { starve: false }));

  // Excluded playlists (blocklist). The pick paths apply this as a hard filter;
  // here it never-starves, since this coast is the last dead-air guard.
  if (excludedIds) {
    const allowed = pool.filter((t: any) => t?.id && !excludedIds.has(t.id));
    if (allowed.length) replacePool(allowed);
  }

  // This fallback bypasses the drain, so it has to stamp what the drain would:
  // loudness gain (same resolver, so both paths level identically), the
  // max-track cue_out cap (#447) and the silence trim (music/silence-trim.ts).
  // No loudness / off / unmeasured → no stamp → unity and an untouched entry.
  for (const t of pool) await queue.applyLoudnessGain(t);

  const lines = ['#EXTM3U', ...pool.map((t: any) => {
    const trim = silenceTrim.resolveSilenceTrim(t);
    return subsonic.getAnnotatedUri(t, {
      maxDurationSec,
      cueInSec: trim.cueInSec,
      cueOutSec: trim.cueOutSec,
    });
  })];
  // Atomic replace: Liquidsoap watches this file (reload_mode="watch"), so an
  // in-place write can trigger a reload of a truncated playlist.
  await writeFileAtomic(config.liquidsoap.autoPlaylist, lines.join('\n'));
  // The atomic rename swaps the inode, so the inotify watch can orphan itself
  // and loop a stale snapshot forever (#874). Force a telnet reload;
  // best-effort, so an unreachable mixer never fails the refresh.
  const reloaded = await reloadAutoPlaylist();
  if (!reloaded) queue.log('scheduler', 'Auto-playlist written but telnet reload failed — relying on inotify watch');

  // Surface a silently-degraded strict genre and a too-thin strict pool (#629).
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
  // Every writer stamps, or the next boundary rebuilds a file already built for
  // this show (#1111).
  autoPlaylistBuild.built(show);
}

// ---------------------------------------------------------------------------
// HOURLY TIME CHECK
// At the top of every hour, the DJ checks in.
// ---------------------------------------------------------------------------

// Gate-free runner — also called directly by the /dj/segment command route as
// an operator override. The cron wrapper below adds the frequency gate.
export async function runHourlyCheck({ showWelcome = false }: { showWelcome?: boolean } = {}) {
  return withTrace({ kind: 'hourly' }, async () => {
    const ctx = await getFullContext();
    // Guest rotation: on a show with co-hosts the ordinary time check may come
    // from a guest. A show welcome belongs to the incoming host: it establishes
    // that show's voice, rather than making a guest appear to take it over.
    const speaker = showWelcome ? session.onAirPersona() : settings.pickOnAirSpeaker();
    const script = await dj.generateHourlyTime({
      recap: queue.getDjRecap(),
      context: ctx,
      recentOpeners: queue.getRecentOpeners(),
      persona: speaker,
      showWelcome,
    });
    await queue.announce(script, 'hourly-check', {
      persona: speaker, meta: { personaId: speaker?.id, personaName: speaker?.name },
    });
    return script;
  });
}

// Roll the DJ session against fresh context and run the boundary hooks (episode
// plan, persona mic-pass, programme intro). The shared boundary sequence: the
// talk tick runs it at :00, the schedule-override routes fire it in the
// background. Every step traps its own errors — node-cron doesn't catch async
// throws and the route callers are fire-and-forget.
//
// `airHandoff` false (the :00 tick) still rolls and plans but leaves the
// mic-pass pending for the next track boundary, since airing at wall-clock :00
// ducks mid-song. `manual` marks operator-driven call sites, which are exempt
// from the handover ordering rule; takeover EXPIRY is not (#1576). `reason`
// names the transition in the booth log's auto-playlist line.
export async function rollSessionNow(
  { airHandoff = true, manual: _manual = false, reason = 'session roll' }:
    { airHandoff?: boolean; manual?: boolean; reason?: string } = {},
) {
  // auto.m3u follows the show too (#1111). Fire-and-forget: holding the audible
  // mic-pass behind Navidrome I/O would duck the outro it must land on. Ahead
  // of the roll (it needs no ctx) so a failed roll can't leave the previous
  // show's fallback on air.
  refreshAutoPlaylistOnShowChange(reason).catch(err =>
    queue.log('error', `Auto-playlist refresh on show change failed: ${err.message}`));
  let ctx: Awaited<ReturnType<typeof getFullContext>> | null = null;
  const priorSession = session.getSession();
  const previousShowId = priorSession?.show?.id ?? null;
  let showStarted = false;
  try {
    ctx = await getFullContext();
    await session.maybeRoll(ctx);
    // Only entering an actual scheduled show earns the optional hourly
    // welcome. A show ending into autonomous radio has nothing to welcome.
    showStarted = !!priorSession && !!ctx.activeShow?.id && ctx.activeShow.id !== previousShowId;
  } catch (err) {
    queue.log('error', `Session roll failed: ${err.message}`);
  }
  // If that roll crossed a persona boundary, air the two-voice mic-pass — when
  // this call site is allowed to (see `airHandoff`). It does its own
  // listener/budget gating and marks itself aired, so it's safe to call
  // unconditionally below (whichever call site rolls the session first drives
  // it — the others no-op). No ctx → the roll above didn't happen either;
  // leave the handoff pending for the next call site.
  if (!ctx) return { ctx: null, introAired: false, showStarted: false };
  // Plan the episode BEFORE the mic-pass so a persona handoff into a
  // programme show can weave the episode angle into the greeting (the
  // greeting doubles as the show's intro on a persona-change boundary).
  try {
    await programme.ensurePlan(ctx);
  } catch (err) {
    queue.log('error', `Programme plan failed: ${err.message}`);
  }
  if (airHandoff && !session.boundaryHandoffAwaitsTrack()) {
    try {
      await djAgent.runPersonaHandoff(queue, ctx);
    } catch (err) {
      queue.log('error', `Persona handoff failed: ${err.message}`);
    }
  }
  // Programme shows: open the episode. The intro owns the top of the show's
  // first hour, so once it airs the generic time check stands down (#310).
  let introAired = false;
  try {
    // `opportunity: false` — a wall-clock tick, not a handover moment. It may
    // hold the intro, but banking its decline would spend the one required
    // opportunity inside the track the sign-off ducked (#1576).
    introAired = await programme.onSessionSettled(queue, ctx, undefined, { opportunity: false });
  } catch (err) {
    queue.log('error', `Programme episode hook failed: ${err.message}`);
  }
  return { ctx, introAired, showStarted };
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
      // This link airs immediately, so ctx's clock is the air time.
      clockIsAirTime: true,
      // `current` is already playing, not a pick about to start — announce mode
      // pins to the "This is" form rather than "Next up".
      currentIsOnAir: true,
      lastLink: queue.getLastLinkText(),
      recap: queue.getDjRecap(),
      recentTracks: queue.getRecentTracks(),
      recentOpeners: queue.getRecentOpeners(),
      persona: speaker,
    });
    // Announce mode drops the link when the track has no artist name; say so
    // rather than answering the press with a silent success.
    if (!script) throw new Error('no link to air — this track has no artist name to announce');
    await queue.announce(script, 'link', {
      persona: speaker, meta: { personaId: speaker?.id, personaName: speaker?.name },
    });
    return script;
  });
}

// Banter: one structured LLM call writes a host/co-host exchange, which
// announceExchange renders per speaker and airs back-to-back.
//
// Gate-free runner — also the /dj/segment operator override, which is why it
// ignores the show's banter toggle; only the roster is non-negotiable, since a
// one-person exchange can't exist.
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

// Whether a banter tick may fire at all, collapsed into one flag for the
// talk-slot planner, which owns the window/gap/logging state machine.
function banterEligible(now: Date): boolean {
  const { show, guests } = settings.getOnAirRoster();
  if (!show?.banter || !guests.length) return false;  // solo show, or not opted in
  if (!shouldFire('banter', now)) return false;
  if (!djCallsAllowed()) return false;  // nobody listening — save the tokens and the breath
  if (!optionalSegmentsAllowed()) return false;  // over the daily token budget
  return true;
}

// Segment director: the talk table's one FILL row (#1500) — offered every fifth
// minute, no wall-clock placement, stands down on any minute a scheduled row
// wants. Its per-kind cooldowns and frequency floor stay in skills/_agent.ts.
function segmentEligible(): boolean {
  if (!autoVoiceAllowed()) return false;  // station voice is off — music only (manual /dj/skill still runs)
  if (programme.onAir()) return false;  // a programme episode owns its talk moments — the director stands down
  if (!djCallsAllowed()) return false;  // nobody listening — skip the segment director
  if (!optionalSegmentsAllowed()) return false;  // over the daily token budget — mute optional segments
  return true;
}

async function runSegmentTick() {
  await withTrace({ kind: 'segment' }, async () => {
    const ctx = await getFullContext();
    await agenticTick(ctx);
  });
}

// Programme beats. Placement is a STATION-clock fact and station zones sit at
// :30/:45 offsets, so the talk tick samples the row every 5 minutes and
// dispatches on programme.dueBeat(); beat flags make repeat ticks no-ops. The
// intro rides the session-settled hook. Gating lives in programme.ts.
//
// Gate-free manual runners (/dj/segment). Intro/outro re-mark their beat so the
// autonomous path doesn't re-open or re-close the show; a manual feature
// deliberately doesn't consume the hour's planned beat.
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

// Station ident. Gate-free runner — the /dj/segment route fires it immediately;
// the scheduled path passes atNextTrack so it holds for the next track boundary
// rather than ducking mid-vocal.
export async function runStationId({ atNextTrack = false } = {}) {
  return withTrace({ kind: 'station-id' }, async () => {
    const ctx = await getFullContext();
    const speaker = settings.pickOnAirSpeaker();
    // A deferred ident can wait across several boundaries, so stamp the daypart
    // offered to the model and let the queue refuse the clip if it changed.
    const daypart = atNextTrack
      ? stationIdDaypartStamp(ctx.clock?.spokenDaypart, speakClockAllowed())
      : null;
    const script = await dj.generateStationId({
      recap: queue.getDjRecap(),
      context: ctx,
      recentOpeners: queue.getRecentOpeners(),
      persona: speaker,
    });
    const opts = { persona: speaker, daypart, meta: { personaId: speaker?.id, personaName: speaker?.name } };
    if (atNextTrack) await queue.announceAtNextTrack(script, 'station-id', opts);
    else await queue.announce(script, 'station-id', opts);
    return script;
  });
}

// TALK TICK — the one cron owning every spoken segment the station produces on
// its own. They compete for the listener's ear, so they are rows in one table
// (talk-scheduler.ts) driven by one per-minute tick (#1500). It carries
// placement, never policy: eligibility resolves through each policy module at
// fire time (talkEligible), and the director's own cadence stays in
// skills/_agent.ts. Everything below traps its own errors — a throw here would
// cost the minute every scheduled segment shares.

// Per-kind slot bookkeeping: which slot has already spoken (claimed BEFORE the
// await, since rendering can outlast a minute and the next tick would start a
// concurrent one), and which slot has already logged its stand-down reason, so
// it is said once rather than once a minute.
const talkFired: Partial<Record<TalkKind, string | null>> = {};
const talkLogged: Partial<Record<TalkKind, string | null>> = {};

// The :00 session roll's outcome. The hourly row's window runs to :09, so a
// postponed check resolves on a tick where no roll happened but still needs the
// roll's result as a gate (#310). Keyed by hour so it can't gate the next one.
type SessionRoll = Awaited<ReturnType<typeof rollSessionNow>>;
let lastRoll: { hourKey: string; roll: SessionRoll } | null = null;

const hourKey = (now: Date) =>
  `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}`;

// Whether a row due this minute may fire. The live gates, still owned by their
// own modules; resolved lazily by the planner for open, unfired rows only.
function talkEligible(kind: TalkKind, now: Date, rolled: SessionRoll | null): boolean {
  if (kind === 'hourly') {
    // A programme intro owns the top of the show's first hour, so the generic
    // time check stands down once it aired (#310). suppressHourly is asked
    // UNCONDITIONALLY, not behind `rolled` — the row retries to :09, and a
    // controller that booted at :03 has no roll to consult and would talk
    // straight over the intro. `introAired` is the extra signal for an intro
    // that aired in this very tick.
    if (programme.suppressHourly(now)) return false;
    if (rolled?.ctx && rolled.introAired) return false;
    if (!shouldFire('hourly', now)) return false;
    if (!djCallsAllowed()) return false;  // nobody listening — stay on the auto playlist
    if (!optionalSegmentsAllowed()) return false;  // over the daily token budget — mute optional segments
    return true;
  }
  if (kind === 'station-id') {
    if (!shouldFire('stationId', now)) return false;
    if (!djCallsAllowed()) return false;  // nobody listening — skip the ident
    if (!optionalSegmentsAllowed()) return false;  // over the daily token budget — mute optional segments
    return true;
  }
  if (kind === 'banter') return banterEligible(now);
  if (kind === 'segment') return segmentEligible();
  // The automatic jingle rotate (#1619). Deliberately none of the gates above:
  // a stinger costs no tokens and no TTS, so the daily budget has nothing to
  // say about it, and neither the mixer's rotate nor an operator press has ever
  // been listener-gated or muted by `tts.enabled` (voice-policy.ts names
  // `jingleRatio: 0` as the way to silence jingles, precisely because the voice
  // switch does not). Keeping those gates off is what makes the move from
  // radio.liq a move rather than a redesign. Whether there is a clip to draw is
  // NOT asked here — that is a readdir+stat sweep and this resolver is
  // synchronous; a rotate that comes due and finds nothing spends the offer
  // and skips, exactly as the mixer's own `source.available` gate did.
  if (kind === 'jingle') {
    const s = settings.get();
    return rotateJingleDue({
      owner: jingleRotateOwner(s),
      ratio: Number(s?.jingleRatio) || 0,
      tracksSinceJingle: queue.rotateJingleTracksSince(),
    });
  }
  // Programme beats carry no frequency/listener/budget gate of their own — a
  // planned episode's beats are the show. `dueBeat` (the row's external slot)
  // has already said one is due.
  if (kind === 'programme') return programme.onAir(now);
  return false;
}

// Dispatch one fired row, with its resolved air mode in scope for everything it
// says.
//
// The scope (broadcast/talk-air.ts) is what makes `djTalkOnlyBetweenTracks`
// reach segments this function never sees: the segment director speaks from
// four sites inside skills/_agent.ts and a programme beat from two more in
// programme.ts, and queue.announce()/announceExchange() act on the scope rather
// than on a flag each of those would have to pass down. Manual runners are
// exempt because they are called from OUTSIDE it — the same exemption the voice
// switch, the clock switch and the frequency ladder already carry, by the same
// mechanism (the manual route never reaches the gate).
async function runTalkSlot(plan: Extract<TalkPlan, { act: 'fire' }>, rolled: SessionRoll | null) {
  // The station has just decided it is going to talk this minute, which is the
  // earliest honest signal that a heavy engine the sidecar idle-unloaded
  // (#1579) is about to be needed. The idle-pause release
  // (broadcast/stream-idle.ts) is the other signal and the better one — it
  // buys minutes — but it only exists when stream.idleWhenEmpty is ON, and
  // that defaults OFF, so a stock station warmed the sidecar nowhere at all
  // and paid every reload as a stall on the line itself. From here the load at
  // least overlaps writing the script and rendering it.
  //
  // Fired at the FIRE, never on an open window: the talk rows cover ~50
  // minutes of the hour, so warming whenever a window is open would reload the
  // model within a tick of every unload and quietly switch the feature off.
  // Fire-and-forget and total, exactly like the idle-pause call — a warm that
  // fails costs the render a model load, which is the un-warmed behaviour.
  //
  // The jingle rotate (#1619) is the one row this must skip. It is the table's
  // only row that is not speech — the clip is already rendered on disk and no
  // engine is reached at all — so warming for it would reload a model nothing
  // is about to use, which is the same "quietly switch the unload off" failure
  // the fire-not-window rule above exists to avoid.
  if (plan.kind !== 'jingle') void warmHeavy();
  return withTalkAir(plan.air, () => runTalkSlotInner(plan, rolled));
}

async function runTalkSlotInner(plan: Extract<TalkPlan, { act: 'fire' }>, rolled: SessionRoll | null) {
  try {
    switch (plan.kind) {
      case 'hourly':
        await runHourlyCheck({ showWelcome: settings.get().djBehaviour.showWelcome && !!rolled?.showStarted });
        return;
      case 'station-id':
        // Read off the PLAN, not hardcoded, so the table stays the only place
        // placement is decided.
        await runStationId({ atNextTrack: plan.air === 'next-track' });
        return;
      case 'banter':
        await runBanter();
        return;
      case 'segment':
        await runSegmentTick();
        return;
      case 'jingle':
        // The planner has already decided the seam is this row's; the queue
        // owns the draw and the handoff (#1619).
        await queue.playRotateJingle();
        return;
      case 'programme': {
        const ctx = await getFullContext();
        if (plan.slot === 'feature') await programme.featureTick(queue, ctx);
        else await programme.outroTick(queue, ctx);
        return;
      }
    }
  } catch (err) {
    queue.log('error', `${TALK_FAILURE_LABEL[plan.kind](plan.slot)} failed: ${err.message}`);
  }
}

// Booth-log wording kept from the crons these rows replaced; operators grep it.
const TALK_FAILURE_LABEL: Record<TalkKind, (slot: string) => string> = {
  hourly: () => 'Hourly check',
  'station-id': () => 'Station ID',
  banter: () => 'Banter',
  segment: () => 'Segment tick',
  jingle: () => 'Jingle rotate',
  programme: slot => `Programme ${slot} tick`,
};

async function talkTick() {
  const now = new Date();

  // :00 is the natural show boundary for STATE. UNCONDITIONAL and deliberately
  // outside the table — not a talk action, so a muted, empty or over-budget
  // station must still roll (#1500 finding 3). It is NOT the boundary for the
  // AIR: airHandoff false leaves the mic-pass for the next track boundary.
  if (now.getMinutes() === 0) {
    // rollSessionNow traps each step, but a rejection here must not take the
    // minute every scheduled segment shares — or the process — with it.
    const roll = await rollSessionNow({ airHandoff: false, reason: 'scheduled boundary' }).catch(err => {
      queue.log('error', `Session roll failed: ${err.message}`);
      return null;
    });
    lastRoll = roll ? { hourKey: hourKey(now), roll } : null;
  }
  const rolled = lastRoll?.hourKey === hourKey(now) ? lastRoll.roll : null;

  // runTalkSlot traps the segments themselves; this covers the planning.
  let plans: TalkPlan[] = [];
  try {
    plans = talkTickPlan({
      now,
      lastTalkBreakAt: queue.getLastTalkBreakAt(),
      pendingTalk: queue.pendingVoiceTalk(),
      eligible: kind => talkEligible(kind, now, rolled),
      externalSlot: kind => (kind === 'programme' ? programme.dueBeat(now) : null),
      // Read once per tick, not per row: the pending-clip hold is only coherent
      // if every row in the plan agrees about it.
      betweenTracksOnly: talkOnlyBetweenTracks(),
      fired: talkFired,
      logged: talkLogged,
    });
  } catch (err) {
    queue.log('error', `Talk tick planning failed: ${err.message}`);
  }

  // Sequential, in the table's dispatch order, so the running order is a
  // property of the table rather than of cron registration order.
  for (const plan of plans) {
    if (plan.act === 'wait') {
      if (plan.markLogged) talkLogged[plan.kind] = plan.markLogged;
      if (plan.log) queue.log('scheduler', plan.log);
      continue;
    }
    talkFired[plan.kind] = plan.slotKey;  // claim the slot before any await — see above
    await runTalkSlot(plan, rolled);
  }
}

async function cleanup() {
  try {
    await cleanupOldVoices();
  } catch (err) {
    queue.log('error', `Cleanup failed: ${err.message}`);
  }
  // Pause-and-talk's silence items. Their own sweep because they live outside
  // config.piper.outDir, and nothing else deletes them — ~3 MB apiece, several
  // an hour, on the volume session.json and the backup archive share.
  try {
    await cleanupPauseTalkSilence();
  } catch (err) {
    queue.log('error', `Pause-and-talk cleanup failed: ${err.message}`);
  }
  // Fold the library DB's WAL back in: without a periodic TRUNCATE checkpoint
  // a bulk write pass leaves it at its high-water mark and every query pays to
  // walk it (#786).
  try {
    library.checkpoint();
  } catch (err) {
    queue.log('error', `Library WAL checkpoint failed: ${err.message}`);
  }
  // Drop event day-files past the retention horizon.
  try {
    const removed = await pruneOldEvents();
    if (removed) queue.log('scheduler', `Cleanup: pruned ${removed} old event log file(s)`);
  } catch (err) {
    queue.log('error', `Event log prune failed: ${err.message}`);
  }
  // Archive retention. 0 (the default) keeps everything.
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
  // Stem cache sweep — keep the per-track Demucs stem windows inside the
  // operator's byte budget (feature: stem-blend transitions), evicting by the
  // music/stem-priority.ts ranking rather than by age. The analysis pass
  // sweeps after itself too; this catches lazily-added dirs.
  try {
    const { removed, freedBytes, failedDirs, overBudgetBytes } = await stemCacheStore.sweep();
    if (removed) {
      queue.log('scheduler',
        `Stem cache: evicted ${removed} track dir(s) (${Math.round(freedBytes / 1_000_000)} MB freed)`);
    }
    // A sweep that couldn't reach the budget is an operator problem, not a
    // no-op (#1257) — say so every hour it persists. Usual cause: the
    // controller can't delete what the analyzer wrote (state/stems ownership).
    if (overBudgetBytes > 0) {
      const budgetGb = settings.get()?.audio?.stemCacheGb ?? 15;
      queue.log('error',
        `Stem cache: still ${(overBudgetBytes / 1024 ** 3).toFixed(1)} GB over its ${budgetGb} GB budget after the sweep` +
        (failedDirs ? ` — ${failedDirs} dir delete(s) failed; check ownership/permissions on state/stems` : ''));
    }
  } catch (err) {
    queue.log('error', `Stem cache sweep failed: ${err.message}`);
  }
  // Rendered transition clips are single-use, so anything over an hour old is
  // an orphan — except clips still queued for a seam that hasn't aired, which
  // can legitimately out-age the window.
  try {
    const removed = await stemBlendStore.cleanupOldClips(queue.pendingClipPaths());
    if (removed) queue.log('scheduler', `Transitions: removed ${removed} orphaned clip(s)`);
  } catch (err) {
    queue.log('error', `Transition clip sweep failed: ${err.message}`);
  }
}

// Nightly health check: caches the doctor assessment so the admin badge is
// populated before the operator opens the panel. LLM-free.
async function nightlyDoctor() {
  try {
    await withTrace({ kind: 'doctor' }, () => doctor.runDoctor());
  } catch (err) {
    queue.log('error', `Nightly health check failed: ${err.message}`);
  }
}

// Scheduled backups (#1570). Off by default; the cadence, name grammar and
// retention all live in backup/pure.ts and this tick only reports. Every
// failure is logged and swallowed — losing the scheduler to a backup would take
// the auto playlist, the talk tick and the takeover janitor with it.
async function scheduledBackupTick() {
  try {
    const r = await backup.runScheduledBackup();
    if (r.written) {
      queue.log('scheduler',
        `Scheduled backup: wrote ${r.written} (${Math.round(r.bytes / 1_000_000)} MB)`
        + (r.pruned.length ? `, removed ${r.pruned.length} older backup(s)` : ''));
    } else if (r.pruned.length) {
      // A retention lowered between cadence boundaries.
      queue.log('scheduler', `Scheduled backup retention: removed ${r.pruned.length} older backup(s)`);
    }
    if (r.sweptTemps.length) {
      // The only trace an operator gets that an expected backup never landed.
      queue.log('scheduler',
        `Scheduled backup: cleaned up ${r.sweptTemps.length} half-written backup file(s) `
        + 'left by an interrupted run');
    }
    // Reported even when a backup WAS written: a successful write plus a failed
    // prune is the disk quietly filling up.
    for (const e of r.errors) queue.log('error', `Scheduled backup: ${e}`);
  } catch (err) {
    queue.log('error', `Scheduled backup failed: ${err.message}`);
  }
}

// Per-skill cron tasks, from the `cron:` frontmatter in SKILL.md. A firing
// timer calls runCapability() directly, bypassing the frequency floor and
// cooldown like /dj/skill — but it is NOT an explicit operator action, so it
// still owes the station-wide talk gates (skillCronAllowed) and the per-skill
// eligibility rules. Both are re-read at FIRE time, not at registration.
// Rebuilt on every syncSkillCrons() call.
const skillCronTasks = new Map<string, ScheduledTask>();

// Gates injected rather than read live so the rule can be pinned
// (scripts/skill-cron-gates.test.ts).
export interface SkillCronGates {
  voiceAllowed: boolean;
  programmeOnAir: boolean;
  djCallsAllowed: boolean;
  optionalSegmentsAllowed: boolean;
}

// Which gate closed, or null when the cron may fire. Separate from the boolean
// below because the reason has to reach the booth log — a registered cron that
// silently never speaks is undiagnosable.
export function skillCronStandDownReason(gates: SkillCronGates): string | null {
  if (!gates.voiceAllowed) return 'the station voice is off (music only)';
  if (gates.programmeOnAir) return 'a programme episode is on air';
  if (!gates.djCallsAllowed) return 'nobody is listening';
  if (!gates.optionalSegmentsAllowed) return 'the daily token budget is spent';
  return null;
}

export function skillCronAllowed(gates: SkillCronGates): boolean {
  return skillCronStandDownReason(gates) === null;
}

export function skillCronEligibility(cap: any, enabled: Record<string, boolean | undefined>, host: any, guests: any[]) {
  return skillEligible({
    seeded: cap.seeded,
    skill: cap.skill,
    enabled,
    personaSkills: host?.skills,
    requiresCohosts: !!cap.cohosts,
    hasCohosts: !!host && guests.length > 0,
  });
}

export function syncSkillCrons() {
  // destroy(), not stop(): node-cron 4 keeps tasks in a process-global registry
  // and stop() only halts firing, leaking one dead task per skill per save.
  for (const task of skillCronTasks.values()) task.destroy();
  skillCronTasks.clear();
  for (const cap of loadedCapabilities()) {
    const expr: string | undefined = cap.cronExpression;
    if (!expr) continue;
    if (!cron.validate(expr)) {
      queue.log('error', `[skills] "${cap.kind}" has invalid cron expression "${expr}" — skipped`);
      continue;
    }
    const tz = getStationTimezone();
    const task = cron.schedule(expr, async () => {
      const gated = skillCronStandDownReason({
        voiceAllowed: autoVoiceAllowed(),      // station voice is off — music only
        programmeOnAir: programme.onAir(),      // a programme episode owns its talk moments
        djCallsAllowed: djCallsAllowed(),        // nobody listening
        optionalSegmentsAllowed: optionalSegmentsAllowed(), // over the daily token budget
      });
      if (gated) {
        queue.log('scheduler', `[skills] cron "${cap.kind}" stood down — ${gated}`);
        return;
      }
      // Same enabled + persona-allowlist rules the autonomous director applies,
      // logged rather than silent — a stood-down cron leaves no other trace.
      const now = new Date();
      const { host, guests } = settings.getOnAirRoster(now);
      const eligible = skillCronEligibility(
        cap,
        settings.get().skills?.enabled || {},
        host,
        guests,
      );
      if (!eligible.allowed) {
        queue.log('scheduler', `[skills] cron "${cap.kind}" stood down — ${eligible.reason}`);
        return;
      }
      try {
        await withTrace({ kind: 'segment' }, async () => {
          const ctx = await getFullContext();
          await runCapability(cap.kind, ctx);
        });
      } catch (err: any) {
        queue.log('error', `[skills] cron "${expr}" skill "${cap.kind}" failed: ${err.message}`);
      }
    }, { timezone: tz });
    skillCronTasks.set(cap.kind, task);
    queue.log('scheduler', `[skills] "${cap.kind}" cron registered: ${expr} (tz: ${tz})`);
  }
}

// Takeover janitor. resolveActiveShow already ignores an expired override, so
// correctness never depends on this tick — it is promptness and hygiene only.
async function overrideJanitor() {
  try {
    const ov = settings.get()?.scheduleOverride;
    if (!ov || Date.now() < ov.expiresAt) return;
    await settings.update({ scheduleOverride: null });
    queue.log('scheduler', '[takeover] override expired — back to the weekly schedule');
    await rollSessionNow({ reason: 'takeover expired' });
  } catch (err) {
    queue.log('error', `Takeover janitor failed: ${err.message}`);
  }
}

export function startScheduler() {
  refreshAutoPlaylist().catch(err => queue.log('error', `Initial playlist failed: ${err.message}`));

  cron.schedule(`*/${config.show.autoQueueRefreshMinutes} * * * *`, refreshAutoPlaylist);

  // Every spoken segment the station produces on its own, plus the
  // unconditional :00 session roll: one tick over one slot table (#1500).
  cron.schedule('* * * * *', talkTick);

  cron.schedule('*/5 * * * *', overrideJanitor);
  cron.schedule('0 * * * *', cleanup);
  cron.schedule('17 4 * * *', nightlyDoctor);

  // Hourly so a station only up part of the day still gets its daily snapshot;
  // the elapsed-time cadence lives in backup/pure.ts. :23 keeps it off the :00
  // cleanup and the */5 janitor. Off by default.
  cron.schedule('23 * * * *', scheduledBackupTick);

  syncSkillCrons();
  // Each task bakes the zone in at registration, so a live timezone change has
  // to re-register them. Subscribing at the source covers every writer.
  onStationTimezoneChange(() => {
    queue.log('scheduler', '[skills] station timezone changed — re-registering skill crons');
    syncSkillCrons();
  });

  queue.log('scheduler', `Scheduler started · skills: ${skillCatalog().map((s: any) => s.name).join(', ')}`);
}
