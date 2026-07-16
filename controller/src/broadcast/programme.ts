// Programme episode runner — turns a `programme: true` show into a produced
// episode: intro → music → feature → music → outro.
//
// The structure is canonical and time-based (no operator rundown): the intro
// airs at the top of the show, one feature beat airs mid-hour (:35, each
// scheduled hour), the outro airs at :55 of the final hour. What makes the
// hour cohere is the EPISODE PLAN — one structured "producer" LLM call at
// session start (llm/internal/prompts/programme.ts) that turns the show's
// standing topic brief + the moment into today's angle, per-hour feature
// topics, and intro/outro notes. Every beat's script references the plan, so
// the intro teases the feature and the outro calls back. When the plan call
// fails the beats degrade to brief-only generation — the arc still airs.
//
// All episode state (plan + which beats aired) lives ON THE SESSION
// (session.attachProgramme / markProgrammeBeat): it survives controller
// restarts, dies with the session at the show boundary, and a beat is marked
// aired BEFORE it generates (the markHandoffAired idempotency pattern) so a
// mid-beat failure or restart can never double-air.
//
// Like dj-agent.runPersonaHandoff, this module never imports queue — the
// callers (queue's track-start path, scheduler's crons, the manual /dj/segment
// runners in scheduler.ts) pass it in, so queue.ts can import this module
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
import { optionalSegmentsAllowed } from './dj-budget.js';
import { withTrace, logEvent } from '../observability/events.js';
import { zonedParts } from '../time.js';

// How long after the intro aired the generic hourly time-check stays
// suppressed: the intro owns the top of the show's first hour (the same
// one-talker-per-slot rule as issue #310); by the next hour the check is
// normal programming again.
const INTRO_SUPPRESSES_HOURLY_MS = 45 * 60 * 1000;

// Pure arc helpers live in programme-pure.ts (dependency-free, so the unit
// test doesn't drag in the queue/settings graph) — re-exported for callers.
import { showSpan, overrideSpan, planFeature, beatWindow } from './programme-pure.js';
export { showSpan, overrideSpan, planFeature, beatWindow };

// The episode's position/length at `now`. A live takeover (#930) IS the
// episode — its window drives the arc, since the pinned show usually isn't in
// the grid at these hours and showSpan can't see it. Otherwise the grid run.
function episodeSpan(now: Date): { index: number; total: number } {
  const ov = settings.getScheduleOverride(now.getTime());
  if (ov) return overrideSpan(ov, now.getTime());
  const { dow, hour } = zonedParts(now);
  return showSpan(settings.get().schedule, dow, hour);
}

// The beat due at this moment on the STATION clock, for the scheduler's
// 5-minute programme tick (see beatWindow for why crons can't fire on fixed
// station minutes directly).
export function dueBeat(now = new Date()): 'feature' | 'outro' | null {
  return beatWindow(zonedParts(now).minute);
}

// ---------------------------------------------------------------------------
// Episode state
// ---------------------------------------------------------------------------

// The active programme show, but only once the session has actually rolled
// into it — beats must never fire against the PREVIOUS session's state, so
// everything below keys off session identity, not the wall clock alone.
function activeEpisode(now = new Date()) {
  const show = settings.resolveActiveShow(now);
  if (!show?.programme) return null;
  const sess = session.getSession();
  if (!sess || sess.key !== `show:${show.id}`) return null;
  return { show, sess };
}

// True while a programme episode is on air — scheduler.skillsTick stands down
// so the generic segment director doesn't compete with the planned beats.
export function onAir(now = new Date()): boolean {
  return !!activeEpisode(now);
}

// True when the generic hourly time-check should stay quiet: the programme
// intro owns the top of the show's first hour (pending → it's about to air in
// this same tick; aired recently → it just did).
export function suppressHourly(now = new Date()): boolean {
  const ep = activeEpisode(now);
  const prog = ep && session.getProgramme();
  if (!prog) return false;
  if (!prog.beats?.intro) return true;
  return !!(prog.introAiredAt && now.getTime() - new Date(prog.introAiredAt).getTime() < INTRO_SUPPRESSES_HOURLY_MS);
}

// The most recent archived episode's angle for this show, so today's producer
// takes a different line. Best-effort: scans the newest few session archives;
// any miss (fresh install, no prior episode) is just null.
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
// and owned by the host persona — the same offer the segment director makes.
function featureKindMenu(host: { skills?: string[] } | null | undefined): { kind: string; desc: string }[] {
  try {
    return skillCatalog()
      .filter((c) => c.enabled && c.ready)
      .filter((c) => !host?.skills || host.skills.includes(c.name))
      .map((c) => ({ kind: c.kind, desc: c.description || c.label }));
  } catch {
    return [];
  }
}

// Attach episode state to a freshly-rolled programme session and generate the
// plan. Idempotent — safe from every call site, every tick. A budget/silence
// gate leaves the plan `pending` (a later tick retries once budget frees up);
// a real generation failure marks it `fallback` for the episode (beats then
// run brief-only — one failed producer call shouldn't burn a retry per tick).
export async function ensurePlan(ctx: SessionContext, now = new Date()): Promise<void> {
  const ep = activeEpisode(now);
  if (!ep) return;
  let prog = session.getProgramme();
  if (!prog) {
    prog = { status: 'pending', plan: null, beats: {}, introAiredAt: null };
    session.attachProgramme(prog);
  }
  if (prog.status !== 'pending') return;
  if (!optionalSegmentsAllowed()) return;  // over budget — stay pending, retry later

  const span = episodeSpan(now);
  // Span is measured from the show's FIRST hour: if the session rolled late
  // (controller boot mid-show), the remaining hours are what the plan covers.
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
        skillKinds: pinned ? [] : featureKindMenu(roster.host),
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

// ---------------------------------------------------------------------------
// Beats
// ---------------------------------------------------------------------------

// Intro — the top of the show. Fires from the same call sites as the persona
// handoff (hourly roll at :00, first track event past the boundary), AFTER
// runPersonaHandoff: when the boundary also changed personas, the incoming
// half of the mic-pass already opened the show (with the episode angle woven
// in — see dj-agent), so the standalone intro is skipped and just marked.
// Returns true when it aired a standalone intro now.
export async function maybeRunIntro(queue: QueueApi, ctx: SessionContext, now = new Date()): Promise<boolean> {
  const ep = activeEpisode(now);
  const prog = ep && session.getProgramme();
  if (!prog || prog.beats?.intro) return false;

  // A persona handoff at this boundary already opened the show on air.
  if (ep.sess.rolledFrom && ep.sess.handoffAired) {
    markIntroAired();
    return false;
  }
  if (!djCallsAllowed() || !optionalSegmentsAllowed()) return false;  // stays pending — may air later this hour

  markIntroAired();
  await runIntro(queue, ctx, now);
  return true;
}

// Mark the intro beat + stamp its air time (suppressHourly keys off the
// stamp). One helper so the autonomous path and the manual runner agree —
// a manual intro must also stand the generic hourly check down (issue seen
// live: manual intro at :52, generic hourly still aired at the next :00).
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
  if (!djCallsAllowed() || !optionalSegmentsAllowed()) return;
  await ensurePlan(ctx, now);  // late plan (budget freed up mid-show) still helps
  session.markProgrammeBeat(beat);
  try {
    await runFeature(queue, ctx, { hourIndex: span.index, now });
  } catch (err) {
    queue.log('error', `Programme feature failed: ${(err as Error).message}`);
  }
}

// Gate-free feature core. Resolution order for what airs: the show's pinned
// segmentSkill, else the plan's kind for this hour — both through the forced
// segment director with the feature topic injected as the brief (real data:
// headlines, weather, search). Any miss (no kind, stale kind, director
// failure) falls to the straight-talk floor so the beat still airs.
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
        return await runCapability(kind, ctx, {
          brief: `This segment is the planned feature of the programme "${show.name}". Today's feature: ${topic}${plan?.angle ? ` (episode angle: ${plan.angle})` : ''}. Build the segment around it.`,
          persona: speaker,
        });
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

// Outro — the sign-off. Cron-driven at :55 of the show's FINAL hour.
export async function outroTick(queue: QueueApi, ctx: SessionContext, now = new Date()): Promise<void> {
  const ep = activeEpisode(now);
  const prog = ep && session.getProgramme();
  if (!prog || prog.beats?.outro) return;
  const span = episodeSpan(now);
  if (span.index !== span.total - 1) return;  // not the final hour yet
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
  // Tease whatever the grid says follows this show (another show's name, or
  // nothing when the station goes back to autonomous hours).
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

// Session-settled hook — the one call both maybeRoll call sites make after
// runPersonaHandoff: attach + plan the episode, then air the intro if it's
// still pending. Returns true when a standalone intro aired just now (the
// hourly cron uses this to skip the generic time check).
export async function onSessionSettled(queue: QueueApi, ctx: SessionContext, now = new Date()): Promise<boolean> {
  if (!activeEpisode(now)) return false;
  await ensurePlan(ctx, now);
  return maybeRunIntro(queue, ctx, now);
}

