// The shapes that flow through the queue: a track as the picker hands it over,
// the queue item wrapping it, and what the watcher reads back off disk.
//
// Part of the queue/ split - see ../queue.ts, which owns the Queue class.

import type { TrackOutro, TrackKeyRange } from '../../music/library-db.js';

// A persona as it flows through the queue's voice path — only `id`/`name`/
// `djMode` are read here; the rest rides through to tts.speak()/voiceGainDb().
export interface Persona {
  id?: string;
  name?: string;
  djMode?: boolean;
  [k: string]: unknown;
}

// A playable track. A loose bag by design: picks arrive from the LLM agent and
// from Subsonic carrying different subsets, and applyMixTransition arms/strips
// the transition-effect flags in place. Every field is optional so a partial
// pick and a fully-analysed one share one type.
export interface Track {
  id?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: number | null;
  duration?: number | null;
  bpm?: number | null;
  musicalKey?: string | null;
  loudnessLufs?: number | null;
  peakDb?: number | null;
  // OpenSubsonic ReplayGain block riding the raw Navidrome song object —
  // subsonic.ts returns API children unmodified, so tagged files carry it
  // into the queue for free. applyLoudnessGain prefers it over the measured
  // LUFS when settings.loudness.source allows (issue #998).
  replayGain?: { trackGain?: number | null; trackPeak?: number | null } | null;
  introMs?: number | null;
  keyRanges?: TrackKeyRange[] | null;
  outro?: TrackOutro | null;
  gainDb?: number;
  // Transition-effect flags + their stamped parameters (armed/stripped by
  // applyMixTransition, consumed by subsonic.getAnnotatedUri and radio.liq).
  sweep?: boolean;
  washout?: boolean;
  washoutAuto?: boolean;
  washoutDelay?: number;
  blend?: boolean;
  dissolve?: boolean;
  chop?: boolean;
  chopPeriod?: number;
  loop?: boolean;
  loopBar?: number;
  crossSec?: number;
  [k: string]: unknown;
}

// One entry in the queue. `upcoming` holds these before play; `current` and
// `history` are the same shape with the runtime-stamped startedAt/endedAt/
// source added.
export interface QueueItem {
  track: Track;
  requestedBy?: string | null;
  intent?: string | null;
  introScript?: string | null;
  introKind?: string;
  // Who WROTE introScript. Carried on the item because the line is rendered in
  // drainToLiquidsoap and aired in airIntro, both later than generation and
  // both of which used to re-resolve the speaker from the wall clock — so
  // across a show boundary a line written for the incoming DJ got spoken in the
  // outgoing DJ's voice. Decided once, at push time. Not persisted: a restart
  // drops unrendered intros anyway, and a stale persona blob is worse than the
  // live fallback.
  introPersona?: Persona | null;
  aiPicked?: boolean;
  linkPrev?: { id: string | null; title: string | null; artist: string | null } | null;
  // Epoch ms of the air moment this item's link was WRITTEN against — stamped
  // only when the generator actually handed the model a clock to speak
  // (queue/pure.ts linkClockAt), so an item with no stamp made no claim about
  // the time and is never dropped for drifting. airIntro compares it with the
  // real air moment; see linkClockDrifted (#1314).
  linkClockAt?: number | null;
  introWav?: string | null;
  introAired?: boolean;
  // Set at drain time when a bed was pushed into dj_queue immediately ahead of
  // this item, meaning its link airs over the BED rather than over this track
  // (broadcast/bed-policy.ts). The bed's own start is what fires airIntro — see
  // onBedStarted — so this is how that event finds the item it belongs to.
  // Both bed fields ride persist()'s wholesale item snapshot, which is what
  // makes the maybePushBed re-drain guard hold across a controller restart.
  bedded?: boolean;
  // The predecessor's exit canvas the bed fades in under. The bed's marker
  // fires at cross-FEED time, this many seconds before the bed is dominant —
  // onBedStarted holds the link for what remains of it.
  bedEntrySec?: number;
  queuedAt?: string;
  sent?: boolean;
  confirmedInLiquidsoap?: boolean;
  // Unique per-handoff token carried in a subhttp URL fragment. Liquidsoap's
  // protocol records ready/failed against it, so queue membership is never
  // mistaken for resolution state.
  resolveProbeId?: string;
  transitionSfx?: string;
  startedAt?: string;
  endedAt?: string;
  source?: string;
  // Effective cue points stamped at drain time. The pair-drain deadline math
  // uses cueOutSec - cueInSec: both are absolute file offsets, while startedAt
  // is the moment playback begins at cueInSec.
  cueInSec?: number;
  cueOutSec?: number;
  // Stem-blend seam (feature: stem-blend transitions). `stemBlend` rides the
  // OUTGOING item: a rendered clip airs after it (written to next.txt right
  // behind its own URI). `stemSeam`/`stemCueInSec` ride the INCOMING item:
  // its entry-side effects are stripped at its own drain (the seam INTO it
  // is pre-rendered) and it cues in past the head the clip already played.
  stemBlend?: { clipPath: string; blendStartSec: number; inCueSec: number } | null;
  stemSeam?: boolean;
  stemCueInSec?: number;
}

// One row in the rolling recent-plays sidecar (the picker's repeat window).
export interface RecentPlay {
  id: string | null;
  title: string | null;
  artist: string | null;
  endedAt: string;
}

// A controller-level log line surfaced to the web UI + the DJ recap.
export interface DjLogEntry {
  id: number;
  kind: string;
  message: string;
  meta: Record<string, unknown>;
  t: string;
}

// now-playing.json as Liquidsoap writes it.
export interface NowPlaying {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  subsonic_id?: string | null;
  [k: string]: unknown;
}

// Random gap between DJ links on auto-played tracks. The frequency setting
// scales how chatty the DJ is:
//   silent     → Infinity (a link is never due; the countdown never reaches 0)
//   quiet      → uniform 8-20 tracks between links
//   moderate   → current behaviour (1-9 85% of the time, 10-15 the other 15%)
//   chatty     → uniform 1-5 tracks
//   aggressive → uniform 1-3 tracks
// A DJ-mode persona reads one rung chattier (effectiveFrequency), so it links
