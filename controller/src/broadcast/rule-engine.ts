// Selection rules — runtime engine.
//
// Force-insert rules with a track-counted cadence are realised in Liquidsoap
// via per-slot playlist files (`state/liquidsoap_rule_N.m3u`). This module
// resolves each enabled track-counted rule's source to a list of songs and
// rewrites those files; settings.writeLiquidsoapRuleSlots takes care of the
// per-slot weight files. A periodic refresh keeps the m3u contents current
// against Navidrome playlist edits.
//
// Minute-counted rules run entirely controller-side. On every minute tick we
// check `lastFiredAt` against the rule's cadence; due rules pick a track from
// their source and inject it at the head of the queue. Per-rule runtime state
// (lastFiredAt, least-recently-played bookkeeping) lives in
// `state/rules-state.json` — kept out of settings.json so it doesn't churn
// the operator's config file every minute.
//
// Exclude rules are NOT handled here. They're applied inline by
// music/picker.ts and llm/tools.ts at pick time.

import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { STATE_DIR } from '../config.js';
import * as settings from '../settings.js';
import * as subsonic from '../music/subsonic.js';
import { queue } from './queue.js';

const RULES_STATE_PATH = `${STATE_DIR}/rules-state.json`;
const RULE_M3U_PATH = (slot: number) => `${STATE_DIR}/liquidsoap_rule_${slot}.m3u`;

type RuleSong = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  year?: number;
  genre?: string;
  path?: string;
};

type RuleState = {
  // ISO timestamp the rule last fired (any cadence kind).
  lastFiredAt?: string;
  // For pickStrategy: 'least-recently-played' — map of subsonic song id to
  // ISO timestamp of last pick. Capped to ~200 entries per rule.
  playedAt?: Record<string, string>;
};

type RulesStateFile = {
  rules: Record<string, RuleState>;
};

let stateCache: RulesStateFile = { rules: {} };
let stateLoaded = false;

async function loadState(): Promise<RulesStateFile> {
  if (stateLoaded) return stateCache;
  stateLoaded = true;
  if (!existsSync(RULES_STATE_PATH)) {
    stateCache = { rules: {} };
    return stateCache;
  }
  try {
    const raw = JSON.parse(await readFile(RULES_STATE_PATH, 'utf8'));
    stateCache = raw && typeof raw === 'object' && raw.rules ? raw : { rules: {} };
  } catch {
    stateCache = { rules: {} };
  }
  return stateCache;
}

let persistTimer: NodeJS.Timeout | null = null;
function persistState() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await writeFile(RULES_STATE_PATH, JSON.stringify(stateCache, null, 2));
    } catch (err: any) {
      queue.log('error', `rule-engine: persist failed: ${err.message}`);
    }
  }, 500);
}

// Source resolution. Returns a (possibly empty) array of subsonic-shaped songs.
async function resolveSongs(rule: any): Promise<RuleSong[]> {
  const { kind, ref } = rule.source;
  try {
    if (kind === 'playlist') return (await subsonic.getPlaylist(ref)) || [];
    if (kind === 'album') return (await subsonic.getAlbum(ref)) || [];
    if (kind === 'genre') return await subsonic.getSongsByGenre(ref, { count: 200 });
    if (kind === 'artist') {
      const artist = await subsonic.getArtist(ref);
      if (!artist) return [];
      const out: RuleSong[] = [];
      for (const a of (artist.album || []).slice(0, 20)) {
        try {
          const songs = await subsonic.getAlbum(a.id);
          out.push(...songs);
        } catch {}
      }
      return out;
    }
  } catch (err: any) {
    queue.log('error', `rule-engine: ${rule.id} source resolve failed: ${err.message}`);
  }
  return [];
}

// Materialise the m3u for every enabled track-counted rule, one per slot. The
// per-slot ratio files are written by settings.writeLiquidsoapRuleSlots; this
// module handles the playlist contents only.
async function materialiseTrackSlots(rules: any[]) {
  const trackRules = rules
    .filter(
      (r: any) =>
        r.enabled &&
        r.mode === 'force-insert' &&
        r.cadence?.kind === 'every-n-tracks',
    )
    .slice(0, settings.RULES_TRACK_SLOT_CAP);
  for (let slot = 1; slot <= settings.RULES_TRACK_SLOT_CAP; slot++) {
    const rule = trackRules[slot - 1];
    const songs = rule ? await resolveSongs(rule) : [];
    const lines = songs
      .filter((s: any) => s?.id)
      .map((s: any) => subsonic.getAnnotatedUri(s));
    await writeFile(RULE_M3U_PATH(slot), lines.join('\n') + (lines.length ? '\n' : ''));
    if (rule && lines.length === 0) {
      queue.log(
        'rules',
        `rule "${rule.name}" resolved to 0 tracks — slot ${slot} inert`,
      );
    }
  }
}

// Pick one song from a resolved list according to the rule's pickStrategy.
function pickFromSource(rule: any, songs: RuleSong[], state: RuleState): RuleSong | null {
  if (!songs.length) return null;
  if (rule.pickStrategy === 'least-recently-played') {
    const seen = state.playedAt || {};
    // Sort by last-played ASC, never-played first.
    const ranked = [...songs].sort((a, b) => {
      const ta = seen[a.id] || '';
      const tb = seen[b.id] || '';
      if (ta && !tb) return 1;
      if (!ta && tb) return -1;
      return ta.localeCompare(tb);
    });
    return ranked[0];
  }
  return songs[Math.floor(Math.random() * songs.length)];
}

function recordPlay(state: RuleState, songId: string) {
  if (!state.playedAt) state.playedAt = {};
  state.playedAt[songId] = new Date().toISOString();
  // Cap the played-at map so a long-running station doesn't accumulate
  // unbounded data. Keep the most recent 200 entries.
  const entries = Object.entries(state.playedAt);
  if (entries.length > 200) {
    entries.sort(([, a], [, b]) => b.localeCompare(a));
    state.playedAt = Object.fromEntries(entries.slice(0, 200));
  }
}

// Effective cadence in milliseconds for a minute-counted rule, with optional
// jitter applied per fire so back-to-back intervals don't feel mechanical.
function minuteCadenceMs(rule: any): number {
  const base = rule.cadence.value * 60_000;
  const jitter = rule.cadence.jitter || 0;
  if (!jitter) return base;
  const factor = 1 + ((Math.random() * 2 - 1) * jitter) / 100;
  return Math.round(base * factor);
}

// Fire one minute-counted rule: resolve, pick, optionally TTS-intro, inject.
async function fireMinuteRule(rule: any, state: RuleState) {
  const songs = await resolveSongs(rule);
  if (!songs.length) {
    queue.log('rules', `rule "${rule.name}" due but source resolved 0 tracks`);
    return;
  }
  const song = pickFromSource(rule, songs, state);
  if (!song) return;
  await queue.injectRule(rule, song);
  recordPlay(state, song.id);
  state.lastFiredAt = new Date().toISOString();
  persistState();
}

// Scheduler entry point — called once per minute. Walks the enabled minute-
// counted rules and fires any that are due.
export async function tick() {
  const all = settings.get().rules || [];
  const minuteRules = all.filter(
    (r: any) =>
      r.enabled &&
      r.mode === 'force-insert' &&
      r.cadence?.kind === 'every-n-minutes',
  );
  if (!minuteRules.length) return;
  const state = await loadState();
  const now = Date.now();
  for (const rule of minuteRules) {
    const rs = (state.rules[rule.id] = state.rules[rule.id] || {});
    if (rs.lastFiredAt) {
      const elapsed = now - Date.parse(rs.lastFiredAt);
      if (elapsed < minuteCadenceMs(rule)) continue;
    }
    try {
      await fireMinuteRule(rule, rs);
    } catch (err: any) {
      queue.log('error', `rule-engine: rule "${rule.name}" failed: ${err.message}`);
    }
  }
}

// Called from settings.update() (when rules change) and from the scheduler's
// periodic refresh tick.
export async function refresh() {
  const rules = settings.get().rules || [];
  await materialiseTrackSlots(rules);
}

// Test endpoint helper. Given a rule (possibly unsaved), report what it would
// match (excludes) or what it would pick (force-inserts). Used by
// POST /api/rules/:id/test.
export async function testRule(rule: any): Promise<{
  matched?: number;
  sample?: { id: string; title: string; artist: string }[];
  picks?: { id: string; title: string; artist: string }[];
  error?: string;
}> {
  if (!rule) return { error: 'no rule supplied' };
  try {
    const songs = await resolveSongs(rule);
    if (rule.mode === 'exclude') {
      return {
        matched: songs.length,
        sample: songs.slice(0, 5).map(s => ({ id: s.id, title: s.title, artist: s.artist })),
      };
    }
    const state = await loadState();
    const rs = state.rules[rule.id] || {};
    const picks: RuleSong[] = [];
    for (let i = 0; i < 3 && songs.length; i++) {
      const p = pickFromSource(rule, songs, rs);
      if (!p) break;
      picks.push(p);
      // For the preview, mutate a throwaway copy of state so successive picks
      // under least-recently-played don't repeat. The real state file is
      // unchanged.
      if (rule.pickStrategy === 'least-recently-played') {
        rs.playedAt = { ...(rs.playedAt || {}), [p.id]: new Date().toISOString() };
      }
    }
    return {
      matched: songs.length,
      picks: picks.map(s => ({ id: s.id, title: s.title, artist: s.artist })),
    };
  } catch (err: any) {
    return { error: err.message };
  }
}
