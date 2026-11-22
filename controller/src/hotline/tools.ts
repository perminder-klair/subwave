// What the DJ can do on a Call (docs/plans/hotline.md, "What the DJ can do").
//
// The provider calls these; the client relays each call to
// `POST /hotline/calls/:id/tool`, authenticated by the Call's own token. Every
// call is treated as coming from that Caller and goes through the normal
// guards, so a forged one gains nothing over a forged `POST /request`.
//
// A Grant is a Request: it goes through the one listener-request chokepoint
// (broadcast/listener-request.ts) and never gets guards of its own. It is
// queued the moment it is granted and stands on its own after that, whatever
// happens to the Call.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as settings from '../settings.js';
import { queue } from '../broadcast/queue.js';
import * as session from '../broadcast/session.js';
import { getFullContext } from '../context.js';
import { generateQueuedRequestIntro } from '../broadcast/request-intro.js';
import { trackFields } from '../broadcast/dj-agent/enqueue.js';
import {
  admitListenerRequest, heldBackForShow, noteRequestFrom, onRepeatCooldown, pushListenerRequest,
  requests, reservedRequesterNames,
} from '../broadcast/listener-request.js';
import { nearestId } from '../llm/sdk.js';
import { PICKER_TOOL_TIMEOUT_MS } from '../llm/tools.js';
import { REQUESTS_DISABLED } from '../middleware/ratelimit.js';
import { cleanRequesterName, isNamedRequester, sanitizeRequestText, stripScriptedOpener } from '../util/request-guard.js';
import { HOTLINE_DEDICATION_NOTE_MAX, HOTLINE_DEDICATION_TO_MAX } from '../schemas/hotline.js';
import { GRANT_REFUSAL_NOTES, type GrantRefusal } from './policy.js';
import { endCall, secondsLeft, type Call } from './line.js';
import type { RealtimeToolDef } from './provider.js';

// The narrow subset of picker tools a Call is offered: the full set would cost
// the conversation its latency. Each keeps its own availability gate.
export const CALL_PICKER_TOOLS = ['searchLibrary', 'identifyRequestedTrack', 'similarSongs', 'tracksByMood'] as const;

const OWN_TOOLS: RealtimeToolDef[] = [
  {
    type: 'function',
    name: 'now_playing',
    description: "What's on air now and the next few tracks queued. The track changes while you talk, so check again rather than remembering.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'show_context',
    description: 'The show on air now: its name, its theme and who is presenting.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'queue_position',
    description: 'How many tracks are queued and roughly how long until a track granted now would play. Use this to tell the caller when to listen out; never promise "next".',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'grant_request',
    description: "Queue ONE track for the caller. track_id must be an exact id from your search results. Add a dedication only if the caller asked for one. If it is refused, the result says why: tell the caller in your own words and offer something else.",
    parameters: {
      type: 'object',
      properties: {
        track_id: { type: 'string', description: 'An exact id from a search result.' },
        dedication_for: { type: 'string', description: `Who the track is dedicated to, in a few words (max ${HOTLINE_DEDICATION_TO_MAX} characters). Omit if no dedication.` },
        dedication_note: { type: 'string', description: `The occasion or gist, in a few words (max ${HOTLINE_DEDICATION_NOTE_MAX} characters). Optional.` },
      },
      required: ['track_id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'decline_request',
    description: "Record that you are not queueing what the caller asked for, with a short reason. Then tell them kindly.",
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'A few words: why not.' } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'end_call',
    description: 'Hang up. Call this after you have said goodbye, or when you are told time is up.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function jsonSchemaOf(schema: unknown): Record<string, unknown> {
  try {
    if (schema instanceof z.ZodType) {
      const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
      return rest;
    }
  } catch { /* fall through */ }
  return { type: 'object', properties: {} };
}

// The tool definitions baked into the Call's session: the Call's own tools plus
// whichever of the picker subset is available on this station.
export function callToolDefs(call: Call): RealtimeToolDef[] {
  const picker: RealtimeToolDef[] = [];
  for (const name of CALL_PICKER_TOOLS) {
    const t = call.picker.tools[name] as any;
    if (!t) continue;
    picker.push({ type: 'function', name, description: String(t.description || ''), parameters: jsonSchemaOf(t.inputSchema) });
  }
  return [...picker, ...OWN_TOOLS];
}

// Until the last queued track has played. Null when any length is unknown,
// never short (the queue's own forecast rule).
function waitBeforeNewTrackSec(): number | null {
  const timing = queue.upcomingTiming();
  if (!timing.length) return 0;
  const last = timing[timing.length - 1];
  return last.airsInSec != null && last.durationSec != null ? last.airsInSec + last.durationSec : null;
}

function nowPlaying() {
  const cur = queue.current?.track;
  return {
    on_air: cur ? { title: cur.title, artist: cur.artist } : null,
    up_next: queue.upcoming.slice(0, 3).map(i => ({ title: i.track?.title, artist: i.track?.artist })),
  };
}

function showContext(call: Call) {
  const show = settings.resolveActiveShow();
  return {
    show: show?.name || null,
    theme: show?.topic || null,
    presenter: call.persona?.name || null,
    moods: Array.isArray(show?.moods) ? show.moods : [],
  };
}

function queuePosition() {
  const waitSec = waitBeforeNewTrackSec();
  return {
    tracks_queued: queue.upcoming.length,
    approx_minutes_until_a_new_track: waitSec == null ? null : Math.max(1, Math.round(waitSec / 60)),
  };
}

function cleanDedication(args: any): { to: string; note: string } | null {
  const rawTo = typeof args?.dedication_for === 'string' ? args.dedication_for.slice(0, HOTLINE_DEDICATION_TO_MAX) : '';
  if (!rawTo.trim()) return null;
  const to = cleanRequesterName(rawTo, reservedRequesterNames());
  if (!isNamedRequester(to)) return null;
  const rawNote = typeof args?.dedication_note === 'string' ? args.dedication_note.slice(0, HOTLINE_DEDICATION_NOTE_MAX) : '';
  const note = rawNote.trim() ? stripScriptedOpener(sanitizeRequestText(rawNote)).text.slice(0, HOTLINE_DEDICATION_NOTE_MAX) : '';
  return { to, note };
}

function refuse(reason: GrantRefusal) {
  return { granted: false, reason, note: GRANT_REFUSAL_NOTES[reason] };
}

const ADMISSION_TO_GRANT: Record<string, GrantRefusal> = {
  'cooldown': 'rate-limited',
  'global-cap': 'rate-limited',
  'one-pending': 'one-pending',
  'queue-full': 'queue-full',
};

async function grant(call: Call, args: any) {
  if (call.grant) return refuse('already-granted');
  const seen = call.picker.seen;
  const asked = typeof args?.track_id === 'string' ? args.track_id.trim() : '';
  let song = asked ? seen.get(asked) : null;
  if (!song && asked && seen.size) {
    const fixed = nearestId(asked, seen.keys());
    if (fixed) song = seen.get(fixed);
  }
  if (!song) return refuse('unknown-track');
  if (REQUESTS_DISABLED || (settings.get() as any)?.requests?.enabled === false) return refuse('requests-closed');
  if (heldBackForShow(queue, song)) return refuse('clean-show');
  if (onRepeatCooldown(queue, song.id)) return refuse('cooldown');
  if (queue.queuedIds().has(song.id)) return refuse('already-queued');
  const admission = admitListenerRequest(queue, call.ip);
  if (!admission.ok) return refuse(ADMISSION_TO_GRANT[admission.reason] ?? 'rate-limited');

  const dedication = cleanDedication(args);
  const waitSec = waitBeforeNewTrackSec();
  call.grant = { trackId: song.id, title: song.title, artist: song.artist };
  // Into the same ledger a typed request uses, so `maxPending` counts it while
  // its intro is written and the one-pending hold applies to this Caller next.
  const entry: any = {
    id: randomUUID(), status: 'pending', requester: call.name,
    text: `Hotline: ${song.title} — ${song.artist}`, createdAt: Date.now(),
  };
  requests.set(entry.id, entry);
  noteRequestFrom(call.ip, entry);
  void commitGrant(call, song, dedication, entry);
  return {
    granted: true,
    title: song.title,
    artist: song.artist,
    dedication: dedication ? 'noted, you will introduce it on air in your own words' : null,
    approx_minutes_until_it_plays: waitSec == null ? null : Math.max(1, Math.round(waitSec / 60)),
    note: 'Granted. Tell the caller roughly when to listen out. Do not grant anything else on this call.',
  };
}

// The rest of a Grant, off the call's clock: the intro (with the Dedication)
// is written by the normal request-intro path, then the track is pushed through
// the chokepoint. An intro that fails leaves a plain request: the track still
// airs (the station keeps making sound).
async function commitGrant(call: Call, song: any, dedication: { to: string; note: string } | null, entry: any) {
  const requester = call.name;
  try {
    let ctx: any = {};
    try { ctx = await getFullContext(); } catch (err) { queue.log('error', `getFullContext for Hotline grant failed: ${(err as Error).message}`); }
    try {
      await session.maybeRoll(ctx);
      const who = isNamedRequester(requester) ? `Listener "${requester}"` : 'A listener';
      session.appendTurn({
        role: 'event', kind: 'request',
        text: `${who} rang the Hotline and asked for "${song.title}" by ${song.artist}`
          + (dedication ? `, dedicated to ${JSON.stringify(dedication.to)}${dedication.note ? ` (${JSON.stringify(dedication.note)})` : ''}` : '')
          + '.',
        meta: dedication?.note ? { requestText: dedication.note } : {},
      });
    } catch (err) {
      queue.log('error', `Session update for Hotline grant failed: ${(err as Error).message}`);
    }
    const intro = await generateQueuedRequestIntro({
      track: song,
      context: ctx,
      requestedBy: requester,
      viaHotline: true,
      dedication,
      recap: queue.getDjRecap(),
      recentTracks: queue.getRecentTracks(),
      recentOpeners: queue.getRecentOpeners(),
    }, dedication?.note || '');
    if (intro.failure) queue.log('error', 'Hotline grant intro failed — queueing without speech');
    if (intro.guard) queue.log('request-guard', `Hotline intro echoed the dedication — ${intro.guard}`);
    const pushed = await pushListenerRequest(queue, {
      track: trackFields(song),
      requestedBy: requester,
      intent: 'hotline request',
      introScript: intro.introScript,
      introKind: 'dj-speak',
      introPersona: intro.introPersona,
      introHostSpeech: intro.introHostSpeech,
    });
    entry.pick = song;
    entry.status = 'resolved';
    if (pushed.status !== 'queued') {
      entry.refused = true;
      queue.log('hotline', `Hotline grant "${song.title}" not queued after all: ${pushed.status}`);
      return;
    }
    const aired = pushed.introDropped ? null : intro.introScript || null;
    session.appendTurn({
      role: 'dj', kind: 'request',
      text: aired || `Queued "${song.title}" for a Hotline caller.`,
      meta: { trackId: song.id, requester },
    });
    queue.log('hotline', `Hotline grant queued: ${song.title} — ${song.artist}${dedication ? ' (with a dedication)' : ''}`);
  } catch (err) {
    entry.status = 'failed';
    queue.log('error', `Hotline grant failed: ${(err as Error).message}`);
  }
}

// Run one relayed tool call. Unknown names and bad arguments answer with an
// error the model can read, never a throw.
export async function runCallTool(call: Call, name: string, rawArgs: unknown): Promise<Record<string, unknown>> {
  let args: any = {};
  if (typeof rawArgs === 'string' && rawArgs.trim()) {
    try { args = JSON.parse(rawArgs); } catch { return { error: 'arguments were not valid JSON' }; }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs;
  }
  const left = secondsLeft(call);
  const withClock = (out: Record<string, unknown>) => ({ ...out, call_seconds_left: left });

  switch (name) {
    case 'now_playing': return withClock(nowPlaying());
    case 'show_context': return withClock(showContext(call));
    case 'queue_position': return withClock(queuePosition());
    case 'grant_request': return withClock(await grant(call, args));
    case 'decline_request': {
      call.declined = String(args?.reason || 'declined').slice(0, 200);
      return withClock({ ok: true });
    }
    case 'end_call': {
      endCall(call.id, 'dj');
      return { ok: true, ended: true };
    }
  }
  if ((CALL_PICKER_TOOLS as readonly string[]).includes(name)) {
    const t = call.picker.tools[name] as any;
    if (!t?.execute) return { error: `${name} is not available on this station` };
    try {
      const out = await t.execute(args, {
        toolCallId: randomUUID(), messages: [], abortSignal: AbortSignal.timeout(PICKER_TOOL_TIMEOUT_MS),
      });
      return withClock(out && typeof out === 'object' ? out : { result: out });
    } catch (err) {
      return withClock({ error: (err as Error).message });
    }
  }
  return { error: `unknown tool ${name}` };
}
