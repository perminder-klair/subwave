// Session DJ agent — the conversational brain that runs over a stream session.
//
// The system posts events into the session ("a track started, pick the next
// one"; "a listener requested X"); this module hands the session chat window
// to a tool-loop agent that explores the library and decides. Its output (the
// chosen track, an optional spoken link/intro) is enqueued and appended back
// to the session as turns, so the next event sees what the DJ just did.
//
// The conversational path is gated on `settings.llm.pickerAgent`. When it is
// off — or when the agent fails for any reason — this falls back to the
// stateless pool picker (music/picker.js) and the stateless link generator
// (llm/dj.js), so a pick is never missed. Either way the session is updated.

import { z } from 'zod';
import * as settings from '../settings.js';
import * as session from './session.js';
import * as picker from '../music/picker.js';
import * as library from '../music/library.js';
import * as mix from '../music/mix.js';
import * as dj from '../llm/dj.js';
import { energyForDaypart } from '../context.js';
import { defineAgent } from '../llm/agent.js';
import { buildPickerTools } from '../llm/tools.js';
import { recordPick } from '../llm/log.js';
import { withTrace, logEvent } from '../observability/events.js';
import { recencyWindowsForLibrary } from '../music/recency.js';

// --- Feature 4: DJ-mode mini-runs ------------------------------------------
// A short, deliberate tempo/key journey across 2-3 consecutive picks. While a
// run is active the pool re-rank is anchored to the run target (not just the
// current track), and the link patter acknowledges the run. State is module-
// level — one station, one run at a time. Cleared when it runs out or when the
// active persona isn't in DJ mode.
let runState: { bpm: number | null; key: string | null; remaining: number } | null = null;

// Resolve {bpm, key} for a track via the library DB (queued/agent picks carry
// only id/title/artist).
function analysisOf(track: any): { bpm: number | null; key: string | null } {
  if (!track) return { bpm: null, key: null };
  if (track.bpm != null || track.musicalKey != null) {
    return { bpm: track.bpm ?? null, key: track.musicalKey ?? null };
  }
  const rec = track.id ? library.get(track.id) : null;
  return { bpm: rec?.bpm ?? null, key: rec?.musicalKey ?? null };
}

// Resolve a track's measured intro runway (ms), for the talk-within-the-intro
// budget enforcement.
function introMsOf(track: any): number | null {
  if (track?.introMs != null) return track.introMs;
  const rec = track?.id ? library.get(track.id) : null;
  return rec?.introMs ?? null;
}

// Probability of STARTING a run on a given pick, by chattiness. Quiet personas
// never start one; a run is a presence behaviour like the rest of DJ mode.
function runStartProbability(): number {
  const f = settings.effectiveFrequency();
  if (f === 'aggressive') return 0.5;
  if (f === 'moderate') return 0.3;
  return 0;
}

// Advance the mini-run state for this pick and return the re-rank target to use
// (or null for "anchor to the current track as usual"). Only does anything in
// DJ mode with an analysed current track.
function advanceRun(djMode: boolean, current: any): { bpm: number | null; key: string | null } | null {
  if (!djMode) { runState = null; return null; }
  if (runState && runState.remaining > 0) {
    runState.remaining--;
    if (runState.remaining <= 0) { const t = { bpm: runState.bpm, key: runState.key }; runState = null; return t; }
    return { bpm: runState.bpm, key: runState.key };
  }
  // No active run — maybe start one off the current track.
  const cur = analysisOf(current);
  if ((cur.bpm == null && cur.key == null) || Math.random() >= runStartProbability()) return null;
  const target = mix.pickRunTarget(cur, energyForDaypart());
  if (!target) return null;
  runState = { bpm: target.bpm, key: target.key, remaining: 1 + Math.floor(Math.random() * 2) }; // 1-2 more after this
  return target;
}

export function runActive(): boolean {
  return !!(runState && runState.remaining > 0);
}

export const PICK_SCHEMA = z.object({
  id: z.string().describe('the exact song id returned by one of the discovery tools — never invent or compose ids'),
  reason: z.string().describe('internal scratchpad only — max 12 words, never shown to the listener; do not justify, just label (e.g. "flow from previous, new artist")'),
  say: z.string().nullable().describe('when the latest event message says to write a spoken link, set this to one or two natural sentences in the DJ voice (back-announce what just played, ease into what is coming, vary your opener); when the event says stay silent, set this to null'),
});

const REQUEST_SCHEMA = z.object({
  id: z.string().describe('the exact song id returned by one of the discovery tools — never invent or compose ids'),
  ack: z.string().describe('short on-air acknowledgement of the listener, in character — max 20 words; no "thank you for listening" or self-intros'),
  intro: z.string().describe('a natural DJ intro for the track in the DJ voice; weave in what the listener asked for without reading the request back verbatim'),
});

// Ultra-minimal — persona + editorial criteria, nothing else. The AI SDK
// already conveys everything else through its own channels: tool descriptions
// (llm/tools.js), the done-tool description (llm/sdk.js), schema field
// descriptions (PICK_SCHEMA above), and the per-pick event message in the
// session window ("Stay silent — no link this time." vs "Also write a short
// link to speak over this track now."). Duplicating those in prompt text
// competes with the framework's structural signals and derails smaller
// models. PICKER_CRITERIA stays because it's editorial preference (flow,
// context, variety, interest) — that's not in any tool or schema.
export function pickSystem() {
  const persona = settings.getEffectivePersona();
  // In DJ mode, lean on the live session history: a working DJ runs threads
  // and calls back to a track or a remark from earlier in the shift. This pairs
  // with the cross-hour memory in broadcast/session.ts, which now keeps that
  // history alive across daypart turnovers.
  const djModeLine = persona?.djMode
    ? `\n\nYou're in full DJ mode — keep the thread alive across tracks: call back to something you played or said earlier in this session when it fits, and build a little momentum rather than treating each pick as isolated.`
    : '';
  // The show topic is the authoritative brief for every pick this hour. It
  // belongs in the system prompt — not only in the session-opening message —
  // because the session window (WINDOW_TURNS=40) scrolls past the opening
  // message within the first hour. Without this, the picker loses all show
  // constraints mid-session and reverts to recency-biased picks.
  const activeShow = settings.resolveActiveShow();
  const showLine = activeShow?.topic
    ? `\n\nCurrent show brief — follow this for every pick:\n${activeShow.topic}`
    : '';
  return `${settings.agentPersonaPreamble(persona, { rules: false })}

You run the station as one continuous shift. The messages above are the live session.${djModeLine}${showLine}

${dj.PICKER_CRITERIA}`;
}

function requestSystem() {
  return `${settings.agentPersonaPreamble(settings.getEffectivePersona(), { rules: false })}

The messages above are the live session — the last user turn is a listener request.`;
}

// Named agents — the picker and request-handler specs in one declarable block
// each. `buildSystem` and `buildTools` resolve persona / per-call filters at
// run time; everything else (schema, step cap, hard timeout, log kind) is
// fixed here so the spec lives in one place. picker-test.mjs reads
// `pickerAgent.maxSteps` / `pickerAgent.timeoutMs` so test runs match prod
// without drifting. The hard timeout is what fails fast into the stateless
// fallback below instead of dragging on a flaky cloud call.
export const pickerAgent = defineAgent({
  kind: 'djAgentPick',
  schema: PICK_SCHEMA,
  // The done-tool path ends the loop at step 1 (COMMIT_AFTER_STEPS in sdk.js)
  // on every provider now; maxSteps is just the backstop.
  maxSteps: 4,
  timeoutMs: 22000,
  buildSystem: () => pickSystem(),
  buildTools: ({ recentIds, recentKeys, recentArtists }) => {
    const activeShow = settings.resolveActiveShow();
    const { maxDurationSec, excludePatterns } = settings.getPickerConfig(activeShow);
    const { tools, seen } = buildPickerTools({ recentIds, recentKeys, recentArtists, maxDurationSec, excludePatterns });
    return { tools, extras: { seen } };
  },
});

export const requestAgent = defineAgent({
  kind: 'djAgentRequest',
  schema: REQUEST_SCHEMA,
  maxSteps: 4,
  timeoutMs: 22000,
  buildSystem: () => requestSystem(),
  // recentArtists deliberately empty — a request for a recently-played artist
  // must still resolve.
  buildTools: ({ recentIds }) => {
    const activeShow = settings.resolveActiveShow();
    const { maxDurationSec, excludePatterns } = settings.getPickerConfig(activeShow);
    const { tools, seen } = buildPickerTools({ recentIds, maxDurationSec, excludePatterns });
    return { tools, extras: { seen } };
  },
});

function trackFields(song) {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    year: song.year,
    genre: song.genre,
  };
}

// `link`, when present, is the between-track line to speak as this pick starts
// playing. It's attached to the queued item so the queue airs it at the
// transition INTO this track (queue.airIntro), not over whatever is currently
// on-air when the pick is made — which is one track earlier (issue #189).
async function enqueuePick(queue, song, reason, source, link: string | null = null) {
  queue.log('ai-pick', `${song.title} — ${song.artist}`, { reason, source });
  recordPick({ song, reason, source });
  await queue.push({
    track: trackFields(song),
    requestedBy: null,
    intent: reason || 'ai pick',
    introScript: link,
    introKind: 'link',
    aiPicked: true,
  });
}

// ---------------------------------------------------------------------------
// Track event — a track started; pick the next one and maybe air a link.
// ---------------------------------------------------------------------------

async function pickViaAgent(queue, { wantLink }) {
  await library.load();
  const windows = recencyWindowsForLibrary(library.stats().distinctArtists);
  // Scale the recency windows to the tagged library's artist diversity: dense
  // catalogues keep the long anti-repeat guard, while small-artist libraries
  // do not exclude every real candidate before the picker sees it.
  const { ids: recentIds, keys: recentKeys } = queue.recentlyPlayed(windows.trackHours);
  const recentArtists = queue.recentArtistsSince(windows.artistHours);

  const { object, steps, toolCalls, extras } = await pickerAgent.run({
    messages: session.windowMessages(),
    recentIds,
    recentKeys,
    recentArtists,
  });

  const song = object?.id ? extras.seen.get(object.id) : null;
  if (!song) {
    // The agent returned an id that isn't in the candidate set it was shown —
    // it fabricated one. The trace still ends ok:true (we fall back to the pool
    // and air a track), so without this explicit event the rejection is
    // invisible to /debug and the log analyzer, which then over-report agent
    // health. Emit it inside the live trace so agent-pick reliability is real.
    logEvent('pick.rejected', { agent: 'pick', id: object?.id ?? null, candidates: extras.seen.size, steps, toolCalls });
    throw new Error(`agent returned unknown id ${object?.id}`);
  }

  const rawSay = typeof object.say === 'string' ? object.say.trim() : '';
  // Talk-within-the-intro (feature 3a): in DJ mode, hard-trim the link to the
  // pick's measured intro runway so the DJ lands before the vocals instead of
  // talking over them. No-op when the pick is un-analysed or not in DJ mode.
  const djMode = !!settings.getEffectivePersona()?.djMode;
  const say = (djMode && rawSay) ? dj.enforceIntroBudget(rawSay, introMsOf(song)) : rawSay;
  // Attach the link to the pick so it airs as the pick starts (back-announcing
  // the track on-air now), instead of immediately over that on-air track (#189).
  await enqueuePick(queue, song, object.reason, 'agent', (wantLink && say) ? say : null);
  session.appendTurn({
    role: 'dj', kind: 'pick',
    text: object.reason || `Selected "${song.title}".`,
    meta: {
      trackId: song.id, title: song.title, artist: song.artist,
      steps, toolCalls, say: say || null,
    },
  });
}

async function pickViaPool(queue, ctx, { wantLink, current }, rankTarget: { bpm: number | null; key: string | null } | null = null) {
  // A DJ-mode mini-run (feature 4) anchors the pool re-rank to the run's
  // tempo/key target instead of the current track. null → today's behaviour.
  const result = await picker.pickViaPool(queue, ctx, rankTarget);
  if (!result) {
    queue.log('picker', 'pool produced no pick');
    return;
  }
  // Build the between-track link BEFORE enqueueing so it can ride on the queued
  // item and air when the pick starts. It back-announces the track on-air right
  // now (`current`) and leads into the pick — because by the time it airs,
  // `current` will have just ended and the pick will be starting (#189).
  let link: string | null = null;
  if (wantLink && current) {
    try {
      link = await dj.generateLink({
        previous: current, current: result.song, context: ctx,
        recap: queue.getDjRecap(),
        recentTracks: queue.getRecentTracks(),
        recentOpeners: queue.getRecentOpeners(),
      });
    } catch (err) {
      queue.log('error', `DJ link failed: ${err.message}`);
    }
  }
  await enqueuePick(queue, result.song, result.reason, result.source || 'pool', link);
  // The reason text is concise on a successful pool pick and useful context for
  // the next turn — but on a failed pool LLM (picker.js returns the sentinel
  // 'fallback (LLM pick failed)'), recording it as the DJ's session turn primes
  // the next agent run with "you failed before", which derails models that read
  // the window. Substitute a neutral phrasing in that case so the conversation
  // still alternates (avoiding user-message coalescing) without the defeatist
  // signal.
  const sessionText = (result.reason && result.reason !== 'fallback (LLM pick failed)')
    ? result.reason
    : `Selected "${result.song.title}".`;
  session.appendTurn({
    role: 'dj', kind: 'pick',
    text: sessionText,
    meta: { trackId: result.song.id, title: result.song.title, artist: result.song.artist },
  });
}

// Called by the queue watcher when an autonomous track starts and the queue is
// empty. Posts the event to the session, then picks the next track (and an
// optional between-track link) via the agent, falling back to the pool.
export async function runTrackEvent(queue, ctx, { wantLink }) {
  return withTrace({ kind: 'track-event', wantLink }, async () => {
    const current = queue.current?.track || null;
    const previous = queue.history[0]?.track || null;
    const djMode = !!settings.getEffectivePersona()?.djMode;

    // Feature 4 — advance/maybe-start a mini-run and get the re-rank target.
    const rankTarget = advanceRun(djMode, current);
    const inRun = runActive();

    // The link clause differs in DJ mode: a working DJ doesn't just ease into
    // the next track, they TEASE it — name the artist or capture its feel so
    // listeners know what's coming. The agent already knows its own pick when
    // it writes `say`, so this costs nothing extra.
    const runClause = inRun
      ? ` You're mid-run — keep the energy moving in the same direction (a touch ${energyForDaypart().speed >= 1 ? 'brisker' : 'mellower'}) and you may nod to it in the link, but never say tempo numbers.`
      : '';
    const linkClause = wantLink
      ? (djMode
          ? ` Also write a short link that airs as your pick starts: back-announce "${current?.title}", then tease what's next — name the artist or capture the feel of the track you pick so listeners know what's coming. If the track you pick shows an intro_ms, keep the link short enough to finish before then, so you land just as the vocals come in.`
          : ` Also write a short link that airs as your pick starts: back-announce "${current?.title}" and lead into the track you pick.`)
      : ' Stay silent — no link this time.';
    // Surface the current track's real Subsonic id so similarSongs /
    // tracksLikeThis ("pass the currently-playing song id") actually have one
    // to pass. Without it the agent fabricates a slug from the title/artist
    // (e.g. "lost-sultaan-romeo") and Navidrome answers "data not found".
    const eventText = `Now playing "${current?.title}" by ${current?.artist}`
      + (current?.id ? ` [id: ${current.id}]` : '')
      + (previous ? ` (after "${previous.title}" by ${previous.artist})` : '')
      + '. Pick the track to play next.'
      + linkClause
      + runClause;
    session.appendTurn({ role: 'event', kind: 'pick', text: eventText });

    if (settings.get().llm?.pickerAgent) {
      try {
        await pickViaAgent(queue, { wantLink });
        return;
      } catch (err) {
        queue.log('error', `DJ agent pick failed: ${err.message} — falling back to pool`);
      }
    }
    await pickViaPool(queue, ctx, { wantLink, current }, rankTarget);
  });
}

// ---------------------------------------------------------------------------
// Request event — a listener asked for something.
// ---------------------------------------------------------------------------

// Returns { ack, track } on success, or null when the conversational agent is
// disabled (the caller then runs its own stateless matcher cascade). Throws if
// the agent runs but fails — the caller catches and falls back the same way.
// The caller (routes/request.js) owns the request `event` turn — it posts one
// for every request path, so the agent only appends its own `dj` reply here.
export async function runRequest(queue: any, ctx: any, { requester, text: _text }: { requester: string; text: string }) {
  if (!settings.get().llm?.pickerAgent) return null;

  return withTrace({ kind: 'request', requester }, async () => {
    // Requests stay near-unfiltered — listeners must be able to re-request a
    // song from earlier in the day. 2h covers the "don't repeat the song still
    // ringing in their ears" case and nothing more.
    const recentIds = queue.recentlyPlayedIds(2);

    const { object, toolCalls, extras } = await requestAgent.run({
      messages: session.windowMessages(),
      recentIds,
    });

    const song = object?.id ? extras.seen.get(object.id) : null;
    if (!song) {
      logEvent('pick.rejected', { agent: 'request', id: object?.id ?? null, candidates: extras.seen.size, toolCalls });
      throw new Error(`request agent returned unknown id ${object?.id}`);
    }

    const intro = typeof object.intro === 'string' ? object.intro.trim() : '';
    await queue.push({
      track: trackFields(song),
      requestedBy: requester,
      intent: 'listener request',
      introScript: intro || null,
      introKind: 'dj-speak',
    });
    session.appendTurn({
      role: 'dj', kind: 'request',
      text: intro || object.ack || `Queued "${song.title}".`,
      meta: { trackId: song.id, requester, toolCalls },
    });

    return {
      ack: object.ack || `Coming up for you, ${requester}.`,
      track: { title: song.title, artist: song.artist },
    };
  });
}
