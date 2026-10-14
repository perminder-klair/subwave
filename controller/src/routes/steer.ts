// Admin-gated steer: lean the music and the talk for a while without touching
// the schedule. Sibling of the takeover routes in routes/shows.ts. A steer and
// a takeover do not run together: starting one clears the other, here in the
// routes, where "clear a takeover" already means update + booth line + roll.
//
// Every steer opens with a fixed list. One pool-picker call works out its first
// tracks; Start queues exactly those, so what the operator is shown is what
// plays, and no further model call is spent on them. A `'once'` steer is that
// list alone, one track long: nothing is stored and nothing else changes.
import express from 'express';
import * as settings from '../settings.js';
import { requireAdmin } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { STEER_MIN_MINUTES, steerRequestSchema, type Steer, type SteerUntil } from '../schemas/steer.js';
import { STEER_ONCE_KEY } from '../broadcast/queue/types.js';
import { serialSteer } from '../music/steer.js';
import { queue } from '../broadcast/queue.js';
import { rollSessionNow } from '../broadcast/scheduler.js';
import { resolveTakeoverWindowNow } from '../broadcast/takeover-window.js';
import { currentMode as budgetCurrentMode, picksAllowed } from '../broadcast/dj-budget.js';
import { enqueuePick, generatePickLink } from '../broadcast/dj-agent/enqueue.js';
import { voiceEnabled } from '../broadcast/voice-policy.js';
import { getFullContext } from '../context.js';
import { pickViaPool } from '../music/picker.js';
import { resolveShowPlaylistPool } from '../music/show-playlist.js';

export const router = express.Router();

export const OPENING_TRACKS = 5;
const MEMO_MS = 5 * 60_000;

interface SteerBody {
  playlistId: string | null;
  prompt: string;
  until: SteerUntil;
  minutes?: number;
  startNow: boolean;
  introduce: boolean;
}

class SteerRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// The last opening list worked out, by what it was worked out FOR. Preview
// fills it; Start uses it and then drops it. The pool is a fresh sample on
// every call, so an entry a few minutes old is no worse a plan than a new one.
let memo: { key: string; at: number; picks: any[]; pool: number } | null = null;

/** Test seam: forget the remembered opening list. */
export function forgetOpeningList(): void {
  memo = null;
}

// The opening tracks for a steer: remembered ones when they were worked out
// for the same request, else one pool-picker call.
async function openingList(steer: Steer, once: boolean): Promise<{ picks: any[]; pool: number; cached: boolean; at: number }> {
  const count = once ? 1 : OPENING_TRACKS;
  const key = `${count}\n${steer.playlistId ?? ''}\n${steer.prompt}`;
  if (memo && memo.key === key && Date.now() - memo.at < MEMO_MS) {
    return { picks: memo.picks, pool: memo.pool, cached: true, at: memo.at };
  }
  if (!picksAllowed()) {
    throw new SteerRefused(409, 'the daily token cap is reached, so picks are paused and the opening tracks could not be worked out');
  }
  let result: { picks: any[]; pool: number } | null;
  try {
    const context = await getFullContext();
    // Starting a steer ends a takeover, so its tracks are chosen under the
    // show the grid puts on air. A single track leaves the takeover running.
    const s = settings.get();
    const activeShow = once ? context.activeShow : settings.resolveActiveShow(new Date(context.at), { ...s, scheduleOverride: null });
    result = await pickViaPool(queue, { ...context, activeShow }, null, null, { preview: { steer, count } });
  } catch (err: any) {
    throw new SteerRefused(502, `could not work out the opening tracks: ${err?.message || err}`);
  }
  if (!result?.picks?.length) throw new SteerRefused(409, 'nothing in the library is eligible under this steer right now');
  memo = { key, at: Date.now(), picks: result.picks, pool: result.pool };
  return { picks: result.picks, pool: result.pool, cached: false, at: memo.at };
}

const brief = (song: any) => ({ id: song.id, title: song.title, artist: song.artist });

// The host's one line before a steer's opening tracks: an ordinary pick link
// into the first, told what follows it.
async function introduction(playable: any[], previous: any, direction: string | undefined) {
  try {
    return await generatePickLink({
      previous,
      current: playable[0],
      context: await getFullContext(),
      clockIsAirTime: false,
      recap: queue.getDjRecap(),
      recentTracks: queue.getRecentTracks(),
      recentOpeners: queue.getRecentOpeners(),
      lastLink: queue.getLastLinkText(),
      // From the request, not settings: a `once` steer is never stored.
      steerIntro: { direction, run: playable.slice(1, OPENING_TRACKS).map(brief) },
    });
  } catch (err: any) {
    queue.log('error', `[steer] could not write the introduction: ${err?.message || err}`);
    return null;
  }
}

// Resolve the request to the steer it asks for. Shared by Preview and Start so
// both judge the same playlist and the same window.
async function steerFromBody(body: SteerBody): Promise<{ steer: Steer; windowMinutes: number; untilSchedule: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  if (body.playlistId) {
    // A playlist that resolves to nothing would leave the picker an empty universe.
    const pool = await resolveShowPlaylistPool({ playlistIds: [body.playlistId] });
    if (!pool) throw new SteerRefused(404, 'that playlist resolved to no tracks');
    // The full-rotation window is the playlist's size less two (music/recency.ts),
    // so below three tracks nothing holds a repeat back.
    if (pool.ids.size < 3 && body.until !== 'once') warnings.push('fewer than 3 tracks: it will loop freely');
  }
  const startedAt = Date.now();
  const resolved = body.until === 'schedule-change' ? resolveTakeoverWindowNow(startedAt) : null;
  // A single track is never stored; its window only has to be a valid one.
  const windowMinutes = resolved ? resolved.minutes : body.until === 'once' ? STEER_MIN_MINUTES : body.minutes!;
  return {
    steer: {
      playlistId: body.playlistId,
      prompt: body.prompt,
      startedAt,
      expiresAt: resolved ? resolved.expiresAt : startedAt + windowMinutes * 60_000,
    },
    windowMinutes,
    untilSchedule: !!resolved,
    warnings,
  };
}

function refuse(res: express.Response, err: any, where: string) {
  if (err instanceof SteerRefused) return res.status(err.status).json({ error: err.message });
  queue.log('error', `${where} failed: ${err?.message || err}`);
  return res.status(400).json({ error: err?.message || String(err) });
}

// Queue the opening tracks as ordinary picks, so a listener cannot tell them
// from the DJ's own; the private marker is how they are found again.
async function queueOpening(picks: any[], key: string, body: SteerBody, introduce = body.introduce) {
  const taken = queue.queuedIds();
  const onAir = queue.current?.track?.id;
  // A remembered list is minutes old: one of its tracks may have aired since.
  const aired = queue.recentlyPlayed(MEMO_MS / 3_600_000).ids;
  const playable = picks.filter(song => !taken.has(song.id) && song.id !== onAir && !aired.has(song.id));
  let skipped = picks.length - playable.length;
  const previous = queue.tailTrack(body.startNow);
  // "Introduce on air": one host link riding the first opening track, the way
  // a pick's own link does, so it lands on the seam into it. An explicit
  // operator switch, so the soft budget tier does not silence it; the
  // station's voice switch still does. A failed line never stops the start.
  const intro = introduce && playable.length && voiceEnabled() ? await introduction(playable, previous, body.prompt) : null;
  const tracks: ReturnType<typeof brief>[] = [];
  for (const [i, song] of playable.entries()) {
    const pos = i === 0 && intro?.link
      ? await enqueuePick(queue, song, 'steer opening list', 'steer', intro.link, previous, {},
        { introPersona: intro.introPersona, hostSpeech: intro.hostSpeech, steerKey: key })
      : await enqueuePick(queue, song, 'steer opening list', 'steer', null, null, {}, { steerKey: key });
    if (pos >= 0) tracks.push(brief(song));
    else skipped++;
  }
  // After the opening tracks are in: the re-pick this triggers when the queue
  // is empty has nothing to do while they wait.
  const drop = body.startNow ? await queue.dropQueuedPicks('steer start') : { dropped: 0, kept: 0, pickInFlight: false };
  return { tracks, skipped, drop };
}

// `budgetMode` rides along so the card can say what a steer is worth right now.
// `queued` is the operator's view of the opening tracks still to air; the
// public queue does not mark them.
router.get('/steer', requireAdmin, async (_req, res) => {
  await settings.load();
  const steer = settings.activeSteer();
  res.json({
    steer,
    budgetMode: budgetCurrentMode(),
    queued: steer ? queue.steerQueued(String(steer.startedAt)).map(i => ({ ...brief(i.track), sent: !!i.sent })) : [],
  });
});

// Work out the opening tracks for a steer WITHOUT starting it. One model call,
// or none when the same request was worked out in the last minutes.
router.post('/steer/preview', requireAdmin, validateBody(steerRequestSchema), async (req, res) => {
  const body = req.body as SteerBody;
  await settings.load();
  try {
    const { steer, warnings } = await steerFromBody(body);
    const opening = await openingList(steer, body.until === 'once');
    res.json({ picks: opening.picks.map(brief), pool: opening.pool, cached: opening.cached, at: opening.at, warnings });
  } catch (err: any) {
    refuse(res, err, 'POST /steer/preview');
  }
});

// Start a steer; re-POSTing replaces a live one. The opening tracks are worked
// out BEFORE anything is saved, so a refused or failed start leaves no
// half-started steer behind.
router.post('/steer', requireAdmin, validateBody(steerRequestSchema), (req, res) => serialSteer(async () => {
  const body = req.body as SteerBody;
  try {
    await settings.load();
    const { steer, windowMinutes, untilSchedule, warnings } = await steerFromBody(body);

    if (body.until === 'once') {
      const opening = await openingList(steer, true);
      const { tracks, skipped, drop } = await queueOpening(opening.picks, STEER_ONCE_KEY, body);
      memo = null;
      queue.log('scheduler', `[steer] one track queued via admin UI${tracks.length ? '' : ' — it was already queued or on air'}`);
      return res.json({ steer: null, tracks, queued: tracks.length, skipped, cached: opening.cached, warnings, ...drop });
    }

    // A steer started at the hard cap would queue its opening and then do
    // nothing, whether or not a preview is remembered.
    if (!picksAllowed()) throw new SteerRefused(409, 'the daily token cap is reached, so picks are paused and a steer would do nothing');
    const opening = await openingList(steer, false);

    const takeover = settings.getScheduleOverride();
    const previous = settings.activeSteer();
    await settings.update(takeover ? { steer, scheduleOverride: null } : { steer });
    const key = String(steer.startedAt);
    let queued: Awaited<ReturnType<typeof queueOpening>>;
    try {
      if (previous) await queue.removeSteerQueued(String(previous.startedAt));
      // The takeover's session ends with it, and a line written under that
      // session would be dropped at air: no introduction on this start.
      if (takeover && body.introduce) queue.log('scheduler', '[steer] no introduction: a takeover was ending');
      queued = await queueOpening(opening.picks, key, body, body.introduce && !takeover);
    } catch (err) {
      // Put back what was in force; the old steer's tracks are gone either way.
      // Each step on its own, since the fault that got us here may recur.
      await queue.removeSteerQueued(key).catch(e => queue.log('error', `[steer] rollback left tracks queued: ${e?.message || e}`));
      await settings.update({ steer: previous, ...(takeover ? { scheduleOverride: takeover } : {}) })
        .catch(e => queue.log('error', `[steer] rollback could not restore what was running: ${e?.message || e}`));
      throw err;
    }
    if (takeover) {
      queue.log('scheduler', '[takeover] cancelled — steer started');
      void rollSessionNow({ manual: true, reason: 'steer started' });
    }
    memo = null;

    const { tracks, skipped, drop } = queued;
    queue.log('scheduler', `[steer] started for ${windowMinutes} min${untilSchedule ? ' (until the schedule changes)' : ''} via admin UI — ${tracks.length} opening track${tracks.length === 1 ? '' : 's'} queued`);
    res.json({ steer, tracks, queued: tracks.length, skipped, cached: opening.cached, warnings, ...drop });
  } catch (err: any) {
    refuse(res, err, 'POST /steer');
  }
}));

// End a steer early, taking its un-aired opening tracks with it. Idempotent.
router.delete('/steer', requireAdmin, (_req, res) => serialSteer(async () => {
  try {
    await settings.load();
    const existing = settings.activeSteer();
    await settings.update({ steer: null });
    const removed = existing ? await queue.removeSteerQueued(String(existing.startedAt)) : { removed: 0, kept: 0 };
    if (existing) queue.log('scheduler', '[steer] cleared via admin UI');
    res.json({ steer: null, ...removed });
  } catch (err: any) {
    refuse(res, err, 'DELETE /steer');
  }
}));
