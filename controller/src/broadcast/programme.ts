// Programme episode runner: turns a `programme: true` show into intro → music →
// feature → music → outro. Structure is time-based, not an operator rundown;
// the outro's placement is `handover.offsetMinutes` (handover-policy.ts).
//
// Episode state (plan + which beats aired) lives ON THE SESSION, and a beat is
// marked aired BEFORE it generates so a mid-beat failure can't double-air.
//
// Never imports queue — callers pass it in, so queue.ts can import this module
// without an eval-time cycle.

import { readdir, readFile, stat } from 'node:fs/promises';
import { config } from '../config.js';
import * as settings from '../settings.js';
import * as session from './session.js';
import type { SessionContext } from './session.js';
import type { QueueApi } from './queue.js';
import * as dj from '../llm/dj.js';
import { runCapability, skillCatalog } from '../skills/_agent.js';
import { djCallsAllowed } from './listeners.js';
import { autoVoiceAllowed } from './voice-policy.js';
import { optionalSegmentsAllowed } from './dj-budget.js';
import { withTrace, logEvent } from '../observability/events.js';
import { zonedParts } from '../time.js';
import { takeoverShowId } from '../schemas/schedule.js';
import { HANDOVER_OFFSET_STEP_MINUTES } from '../schemas/settings.js';
import { handoverOffsetMinutes } from './handover-policy.js';

// How long after the intro aired the generic hourly time-check stays
// suppressed: the intro owns the top of the show's first hour (#310).
const INTRO_SUPPRESSES_HOURLY_MS = 45 * 60 * 1000;

// Pure arc helpers, re-exported for callers.
import { showSpan, overrideSpan, planFeature, beatWindow } from './programme-pure.js';
export { showSpan, overrideSpan, planFeature, beatWindow };

// The episode's position/length at `now`. A live SHOW takeover (#930) IS the
// episode — the pinned show usually isn't in the grid at these hours, so
// showSpan can't see it. Otherwise the grid run.
function episodeSpan(now: Date): { index: number; total: number } {
  const ov = settings.getScheduleOverride(now.getTime());
  if (ov && takeoverShowId(ov)) return overrideSpan(ov, now.getTime());
  const { dow, hour } = zonedParts(now);
  return showSpan(settings.get().schedule, dow, hour);
}

// The beat due at this moment on the STATION clock. The outro's placement comes
// through the policy module, never read from settings here.
export function dueBeat(now = new Date()): 'feature' | 'outro' | null {
  return beatWindow(zonedParts(now).minute, handoverOffsetMinutes(), HANDOVER_OFFSET_STEP_MINUTES);
}

// The active programme show, but only once the session has rolled into it —
// beats must never fire against the previous session's state, so this keys off
// session identity, not the wall clock alone.
function activeEpisode(now = new Date()) {
  const show = settings.resolveActiveShow(now);
  if (!show?.programme) return null;
  const sess = session.getSession();
  if (!sess || sess.key !== `show:${show.id}`) return null;
  return { show, sess };
}

// scheduler.skillsTick stands down on this so the generic segment director
// doesn't compete with the planned beats.
export function onAir(now = new Date()): boolean {
  return !!activeEpisode(now);
}

// The programme intro owns the top of the show's first hour: pending means it
// is about to air this tick, a recent stamp means it just did.
export function suppressHourly(now = new Date()): boolean {
  const ep = activeEpisode(now);
  const prog = ep && session.getProgramme();
  if (!prog) return false;
  if (!prog.beats?.intro) return true;
  return !!(prog.introAiredAt && now.getTime() - new Date(prog.introAiredAt).getTime() < INTRO_SUPPRESSES_HOURLY_MS);
}

// The most recent archived episode's angle for this show, so today's producer
// takes a different line. Best-effort; any miss is null.
async function previousAngle(showId: string): Promise<string | null> {
  try {
    const files = (await readdir(config.session.dir)).filter(f => f.endsWith('.json'));
    const stamped = await Promise.all(files.map(async f => {
      try { return { f, t: (await stat(`${config.session.dir}/${f}`)).mtimeMs }; } catch { return null; }
    }));
    const newest = stamped
      .filter((x): x is { f: string; t: number } => Boolean(x))
      .sort((a, b) => b.t - a.t)
      .slice(0, 12);
    for (const entry of newest) {
      try {
        const s = JSON.parse(await readFile(`${config.session.dir}/${entry.f}`, 'utf8'));
        if (s?.show?.id === showId && s?.programme?.plan?.angle) return String(s.programme.plan.angle);
      } catch {}
    }
  } catch {}
  return null;
}

// The capability menu the producer may build features from: enabled, ready,
// owned by the host persona, and co-hosted skills only when the episode has
// guests. A kind the beat cannot run plans an hour that falls to straight talk.
export function featureKindMenu(host: { skills?: string[] } | null | undefined, hasCohosts: boolean): { kind: string; desc: string }[] {
  try {
    return skillCatalog()
      .filter((c) => c.enabled && c.ready)
      .filter((c) => !host?.skills || host.skills.includes(c.name))
      .filter((c) => !c.cohosts || hasCohosts)
      .map((c) => ({ kind: c.kind, desc: c.description || c.label }));
  } catch {
    return [];
  }
}

// Attach episode state to a freshly-rolled programme session and generate the
// plan. Idempotent. A budget/voice gate leaves the plan `pending` (retried on a
// later tick); a generation failure marks it `fallback` for the episode.
//
// `now` defaults to the moment the CONTEXT describes, not the wall clock:
// onTrackStarted rolls on a look-ahead context, and a live `now` inside that
// window would compare the incoming session key against the outgoing show.
export async function ensurePlan(ctx: SessionContext, now = session.contextDate(ctx)): Promise<void> {
  const ep = activeEpisode(now);
  if (!ep) return;
  let prog = session.getProgramme();
  if (!prog) {
    prog = { status: 'pending', plan: null, beats: {}, introAiredAt: null };
    session.attachProgramme(prog);
  }
  if (prog.status !== 'pending') return;
  if (!autoVoiceAllowed()) return;  // station voice is off — no beat will air, so don't buy a plan
  if (!optionalSegmentsAllowed()) return;  // over budget — stay pending, retry later

  const span = episodeSpan(now);
  // Span is measured from the show's FIRST hour; the plan covers what's left.
  const hoursLeft = Math.max(1, span.total - span.index);
  const roster = settings.getOnAirRoster(now);
  const pinned = String(ep.show.segmentSkill || '').trim() || null;
  const prevAngle = await previousAngle(ep.show.id);
  try {
    const plan = await withTrace({ kind: 'programme-plan', show: ep.show.name }, () =>
      dj.generateProgrammePlan({
        show: ep.show,
        spanHours: hoursLeft,
        host: roster.host,
        guests: roster.guests,
        context: ctx,
        previousAngle: prevAngle,
        skillKinds: pinned ? [] : featureKindMenu(roster.host, roster.guests.length > 0),
        pinnedKind: pinned,
      }));
    prog.status = 'ok';
    prog.plan = plan;
    session.attachProgramme(prog);
    logEvent('programme.plan', { show: ep.show.name, angle: plan?.angle || null });
  } catch (err) {
    prog.status = 'fallback';
    session.attachProgramme(prog);
    logEvent('programme.plan', { show: ep.show.name, error: (err as Error).message });
  }
}

// Intro — the top of the show. Fires from the same call sites as the persona
// handoff, AFTER runPersonaHandoff: when the boundary also changed personas the
// mic-pass already opened the show, so the standalone intro is skipped and just
// marked. Returns true when a standalone intro aired now.
export async function maybeRunIntro(
  queue: QueueApi,
  ctx: SessionContext,
  now = session.contextDate(ctx),
  { opportunity = false }: { opportunity?: boolean } = {},
): Promise<boolean> {
  const ep = activeEpisode(now);
  const prog = ep && session.getProgramme();
  if (!prog || prog.beats?.intro) return false;

  // A persona handoff at this boundary already opened the show on air.
  if (ep.sess.rolledFrom && ep.sess.handoffAired) {
    markIntroAired();
    return false;
  }
  // The mic-pass is still pending for this boundary and doubles as the intro;
  // airing the standalone intro now would duck mid-song and introduce the
  // episode twice. Stays pending — the boundary tick re-runs this after
  // runPersonaHandoff.
  if (session.pendingHandoff()) return false;
  // Voice off / over budget / quiet: stays pending and unmarked, so the intro
  // can still open the remaining hours if the gate reopens.
  if (!autoVoiceAllowed()) return false;
  if (!djCallsAllowed() || !optionalSegmentsAllowed()) return false;
  // The ordering rule (#1576): a show whose sign-off just aired owes the
  // listener one closing track. Asked after the pendingHandoff check so exactly
  // one of the two counts the opportunity, and LAST of the gates so only a
  // cycle that could otherwise have aired the intro banks a decline.
  // `opportunity` says whether this call site is a handover moment at all — the
  // boundary path is, the wall-clock :00 roll is not.
  if (queue.closingTrackHolds()) {
    if (opportunity) queue.noteHandoverOpportunityDeclined();
    return false;
  }

  markIntroAired();
  await runIntro(queue, ctx, now);
  return true;
}

// Mark the intro beat + stamp its air time (suppressHourly keys off the stamp).
// One helper so the autonomous and manual paths agree — a manual intro must
// also stand the generic hourly check down.
export function markIntroAired() {
  const prog = session.getProgramme();
  if (!prog) return;
  session.markProgrammeBeat('intro');
  prog.introAiredAt = new Date().toISOString();
  session.attachProgramme(prog);
}

// Gate-free intro core — also the manual /dj/segment runner (via scheduler's
// wrapper, which re-marks the beat so the autonomous path never repeats it).
export async function runIntro(queue: QueueApi, ctx: SessionContext, now = new Date()): Promise<string> {
  const show = settings.resolveActiveShow(now);
  if (!show?.programme) throw new Error('no programme show is on air');
  const prog = session.getProgramme();
  const plan = prog?.plan || null;
  return withTrace({ kind: 'programme-intro', show: show.name }, async () => {
    const roster = settings.getOnAirRoster(now);
    const common = {
      show, plan, context: ctx,
      recap: queue.getDjRecap(), recentOpeners: queue.getRecentOpeners(),
    };
    if (roster.guests.length && roster.host) {
      try {
        const lines = await dj.generateProgrammeExchange({ beat: 'intro', host: roster.host, guests: roster.guests, ...common });
        if (lines && await queue.announceExchange(lines, 'programme-intro')) {
          return lines.map((l: { persona: { name: string }; text: string }) => `${l.persona.name}: ${l.text}`).join('\n');
        }
      } catch (err) {
        queue.log('error', `Programme intro exchange failed, falling back solo: ${(err as Error).message}`);
      }
    }
    const script = await dj.generateProgrammeIntro({ persona: roster.host, ...common });
    await queue.announce(script, 'programme-intro', {
      persona: roster.host, meta: { personaId: roster.host?.id, personaName: roster.host?.name },
    });
    return script;
  });
}

// Feature — the planned mid-hour segment. Cron-driven at :35 each show hour.
export async function featureTick(queue: QueueApi, ctx: SessionContext, now = new Date()): Promise<void> {
  const ep = activeEpisode(now);
  const prog = ep && session.getProgramme();
  if (!prog) return;
  const span = episodeSpan(now);
  const beat = `feature:${span.index}`;
  if (prog.beats?.[beat]) return;
  if (!autoVoiceAllowed()) return;  // station voice is off (manual /dj/segment still runs the beat)
  if (!djCallsAllowed() || !optionalSegmentsAllowed()) return;
  await ensurePlan(ctx, now);  // late plan (budget freed up mid-show) still helps
  session.markProgrammeBeat(beat);
  try {
    await runFeature(queue, ctx, { hourIndex: span.index, now });
  } catch (err) {
    queue.log('error', `Programme feature failed: ${(err as Error).message}`);
  }
}

// Gate-free feature core. Resolution order: the show's pinned segmentSkill,
// else the plan's kind for this hour, both through the forced segment director
// with the feature topic as the brief. Any miss falls to the straight-talk
// floor so the beat still airs.
export async function runFeature(queue: QueueApi, ctx: SessionContext, { hourIndex = null, now = new Date() }: { hourIndex?: number | null; now?: Date } = {}): Promise<string> {
  const show = settings.resolveActiveShow(now);
  if (!show?.programme) throw new Error('no programme show is on air');
  const prog = session.getProgramme();
  const plan = prog?.plan || null;
  const idx = hourIndex ?? episodeSpan(now).index;
  const feature = planFeature(plan, idx);
  const topic = feature?.topic || show.topic || `the heart of "${show.name}"`;
  const kind = String(show.segmentSkill || '').trim() || feature?.kind || null;

  return withTrace({ kind: 'programme-feature', show: show.name, capability: kind || 'talk' }, async () => {
    const speaker = settings.pickOnAirSpeaker(now);
    if (kind) {
      try {
        const run = await runCapability(kind, ctx, {
          brief: `This segment is the planned feature of the programme "${show.name}". Today's feature: ${topic}${plan?.angle ? ` (episode angle: ${plan.angle})` : ''}. Build the segment around it.`,
          persona: speaker,
        });
        if (run.aired && run.text) return run.text;
        // Skill stood down for want of usable data (#1412). The beat is still
        // mandatory, so fall through to the straight-talk floor.
        queue.log('scheduler', `Programme feature capability "${kind}" stood down (${run.reason || 'no usable data'}) — airing straight talk instead`);
      } catch (err) {
        queue.log('error', `Programme feature capability "${kind}" failed (${(err as Error).message}) — airing straight talk instead`);
      }
    }
    const script = await dj.generateProgrammeFeature({
      show, topic, plan, persona: speaker, context: ctx,
      recap: queue.getDjRecap(), recentOpeners: queue.getRecentOpeners(),
    });
    await queue.announce(script, 'programme-feature', {
      persona: speaker, meta: { personaId: speaker?.id, personaName: speaker?.name },
    });
    return script;
  });
}

// Outro — the sign-off. Driven by the talk table's programme row in the show's
// FINAL hour, `handover.offsetMinutes` before the boundary (:55 by default).
export async function outroTick(queue: QueueApi, ctx: SessionContext, now = new Date()): Promise<void> {
  const ep = activeEpisode(now);
  const prog = ep && session.getProgramme();
  if (!prog || prog.beats?.outro) return;
  const span = episodeSpan(now);
  if (span.index !== span.total - 1) return;  // not the final hour yet
  if (!autoVoiceAllowed()) return;  // station voice is off (manual /dj/segment still runs the beat)
  if (!djCallsAllowed() || !optionalSegmentsAllowed()) return;
  session.markProgrammeBeat('outro');
  try {
    await runOutro(queue, ctx, now);
  } catch (err) {
    queue.log('error', `Programme outro failed: ${(err as Error).message}`);
  }
}

// Gate-free outro core.
export async function runOutro(queue: QueueApi, ctx: SessionContext, now = new Date()): Promise<string> {
  const show = settings.resolveActiveShow(now);
  if (!show?.programme) throw new Error('no programme show is on air');
  const prog = session.getProgramme();
  const plan = prog?.plan || null;
  // Tease whatever the grid says follows this show, if anything.
  const next = settings.resolveActiveShow(new Date(now.getTime() + 60 * 60 * 1000));
  const nextShowName = next && next.id !== show.id ? next.name : null;
  return withTrace({ kind: 'programme-outro', show: show.name }, async () => {
    const roster = settings.getOnAirRoster(now);
    const common = {
      show, plan, context: ctx, nextShowName,
      recap: queue.getDjRecap(), recentOpeners: queue.getRecentOpeners(),
    };
    if (roster.guests.length && roster.host) {
      try {
        const lines = await dj.generateProgrammeExchange({ beat: 'outro', host: roster.host, guests: roster.guests, ...common });
        if (lines && await queue.announceExchange(lines, 'programme-outro')) {
          return lines.map((l: { persona: { name: string }; text: string }) => `${l.persona.name}: ${l.text}`).join('\n');
        }
      } catch (err) {
        queue.log('error', `Programme outro exchange failed, falling back solo: ${(err as Error).message}`);
      }
    }
    const script = await dj.generateProgrammeOutro({ persona: roster.host, ...common });
    await queue.announce(script, 'programme-outro', {
      persona: roster.host, meta: { personaId: roster.host?.id, personaName: roster.host?.name },
    });
    return script;
  });
}

// The one call both maybeRoll call sites make after runPersonaHandoff: attach +
// plan the episode, then air the intro if still pending. Returns true when a
// standalone intro aired. `now` follows ensurePlan's contextDate rule.
//
// `opportunity` passes through to maybeRunIntro (#1576) and has no default
// here on purpose: a new call site must state whether it is a handover moment.
export async function onSessionSettled(
  queue: QueueApi,
  ctx: SessionContext,
  now = session.contextDate(ctx),
  { opportunity }: { opportunity: boolean },
): Promise<boolean> {
  if (!activeEpisode(now)) return false;
  await ensurePlan(ctx, now);
  return maybeRunIntro(queue, ctx, now, { opportunity });
}

