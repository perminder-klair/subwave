// Stream session — the DJ's current run, captured as a chat history.
//
// A session is a runtime instance of either a scheduled show or an autonomous
// block. It holds a `messages` array of turns: events the system posts ("track
// ended, pick the next one"), the DJ agent's replies, track plays, and spoken
// segments — each timestamped. The DJ agent (broadcast/dj-agent.js) reads a
// bounded window of this history so the DJ has real memory within a run.
//
// Lifecycle:
//   - `sessionKeyFor(ctx)` derives an identity from the active show, or from
//     the time period + dominant mood for an autonomous block.
//   - `maybeRoll(ctx)` ends the current session and starts a new one whenever
//     that key changes (a show begins/ends, the mood flips) or the session
//     ages past MAX_SESSION_MS. A short plain-text handoff carries forward.
//   - The live session is persisted to state/session.json; archived sessions
//     land in state/sessions/<id>.json on roll.

import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import * as settings from '../settings.js';
import { logEvent } from '../observability/events.js';

const MAX_SESSION_MS = 4 * 60 * 60 * 1000;  // safety cap — roll even if key is stable
const WINDOW_TURNS = 40;                    // turns fed to the agent
// Hard bound on the messages array. A normal 4h session generates a few
// hundred turns, so this never trims in practice — it exists because persist()
// rewrites the whole array on every turn (1s debounce), and an unbounded array
// makes that O(n²) over the session (and lets a pathological session grow
// session.json without limit). Far above WINDOW_TURNS and everything
// buildHandoff reads, so trimming is invisible to the agent.
const MAX_TURNS = 500;
const RATIONALE_WINDOW = 3;                 // most-recent dj/pick reasons kept in the window (anti-thread-momentum)
const PERSIST_DEBOUNCE_MS = 1000;

let _session: any = null;
let _writeTimer: NodeJS.Timeout | null = null;

function mintId() {
  return 'sess_' + randomBytes(4).toString('hex');
}

// Identity of the run. Consecutive hours of the same show share one session;
// an autonomous block rolls when its time period or dominant mood changes.
export function sessionKeyFor(ctx: any) {
  if (ctx?.activeShow?.id) return `show:${ctx.activeShow.id}`;
  return `auto:${ctx?.time?.period || 'unknown'}:${ctx?.dominantMood || 'none'}`;
}

function scenarioOf(ctx: any) {
  const w = ctx?.weather?.condition;
  return {
    period: ctx?.time?.period || null,
    vibe: ctx?.time?.vibe || null,
    mood: ctx?.dominantMood || null,
    weather: w && w !== 'unknown' ? w : null,
    festival: ctx?.festival?.name || null,
  };
}

function scenarioText(s: any) {
  if (s.kind === 'show') {
    return `Show "${s.show?.name}" begins${s.show?.topic ? ` — theme: ${s.show.topic}` : ''}.` +
           ` Host: ${s.persona?.name || 'the DJ'}.`;
  }
  const sc = s.scenario;
  const bits = [
    `${sc.period || 'now'}${sc.vibe ? ` (${sc.vibe})` : ''}`,
    sc.mood ? `mood ${sc.mood}` : null,
    sc.weather ? `weather ${sc.weather}` : null,
    sc.festival ? `festival ${sc.festival}` : null,
  ].filter(Boolean);
  return `Autonomous block begins — ${bits.join(', ')}.`;
}

// Compact continuity summary of a finished session, carried into the next one
// (only on a HARD roll now — a show boundary or the 4h cap; daypart turnovers
// keep the live session instead, see maybeRoll). Enriched with the prior
// persona + mood so a new program still opens with a sense of where the station
// just was.
//
// STILL intentionally omits the "recently aired" track list — leaking the
// previous session's titles into the new picker's prompt window biases it
// toward re-picking those same tracks (observed cause of 6-8× daily repeats).
// The picker has its own recents window for blocking repeats. Do not add titles.
function buildHandoff(prev: any) {
  if (!prev) return null;
  const lastSpoken = [...prev.messages].reverse()
    .find((m: any) => m.role === 'dj' || m.role === 'segment');
  const parts = [
    prev.kind === 'show'
      ? `the show "${prev.show?.name}"`
      : `a ${prev.scenario?.period || ''} block`,
  ];
  if (prev.persona?.name) parts.push(`hosted as ${prev.persona.name}`);
  if (prev.scenario?.mood) parts.push(`mood ${prev.scenario.mood}`);
  if (lastSpoken?.text) parts.push(`you last said: "${lastSpoken.text.slice(0, 120)}"`);
  return parts.join(' — ');
}

async function persist() {
  if (!_session) return;
  try {
    // Atomic replace — /debug and boot recovery read this file, and a crash
    // mid-write should leave the previous snapshot, not a truncated one.
    await writeFileAtomic(config.session.currentFile, JSON.stringify(_session, null, 2));
  } catch {}
}

function schedulePersist() {
  if (_writeTimer) return;
  _writeTimer = setTimeout(() => { _writeTimer = null; persist(); }, PERSIST_DEBOUNCE_MS);
}

async function archive(s: any) {
  if (!s?.id) return;
  try {
    await mkdir(config.session.dir, { recursive: true });
    await writeFileAtomic(`${config.session.dir}/${s.id}.json`, JSON.stringify(s, null, 2));
  } catch {}
}

export function getSession() {
  return _session;
}

// Append a turn. `role` ∈ event|dj|track|segment; `kind` names the turn type
// (scenario|pick|request|play|link|station-id|hourly|weather|...).
export function appendTurn({ role, kind, text, meta = {} }: { role: string; kind: string; text?: string; meta?: any }) {
  if (!_session) return null;
  const turn = { t: new Date().toISOString(), role, kind, text: text || '', meta };
  _session.messages.push(turn);
  if (_session.messages.length > MAX_TURNS) {
    _session.messages.splice(0, _session.messages.length - MAX_TURNS);
  }
  schedulePersist();
  return turn;
}

// Start a fresh session for the current context.
export function start(ctx: any, handoff: any = null): any {
  const persona = settings.getEffectivePersona();
  _session = {
    id: mintId(),
    kind: ctx?.activeShow ? 'show' : 'auto',
    key: sessionKeyFor(ctx),
    startedAt: new Date().toISOString(),
    endedAt: null,
    show: ctx?.activeShow
      ? { id: ctx.activeShow.id, name: ctx.activeShow.name, topic: ctx.activeShow.topic }
      : null,
    persona: persona ? { id: persona.id, name: persona.name } : null,
    scenario: scenarioOf(ctx),
    handoff: handoff || null,
    // Programme episode state (plan + which beats aired) — attached lazily by
    // broadcast/programme.ts when the session belongs to a programme show.
    // Lives on the persisted session so a restart mid-episode can't re-plan or
    // double-air a beat, and dies with the session at the show boundary.
    programme: null,
    messages: [],
  };
  // appendTurn above already scheduled a debounced persist. No immediate
  // write here: maybeRoll's hard-roll path stamps rolledFrom right after
  // start() returns and awaits its own persist() — an unawaited write started
  // now could land AFTER that stamped write and leave a stale (handoff-less)
  // session.json on disk until the next debounce.
  appendTurn({ role: 'event', kind: 'scenario', text: scenarioText(_session) });
  // Milestone on the unified timeline — marks where one DJ run ends and the
  // next begins, so traces can be grouped by the session they belong to.
  logEvent('session.start', {
    sessionId: _session.id, kind: _session.kind, key: _session.key,
    handoff: handoff || null,
  });
  return _session;
}

async function end() {
  if (!_session) return;
  _session.endedAt = new Date().toISOString();
  await persist();
  await archive(_session);
  logEvent('session.end', { sessionId: _session.id, key: _session.key });
}

// Decide whether to keep the live session or roll to a fresh one.
//
// A daypart/mood turnover *within* an autonomous run is NOT a program change —
// it's the same DJ on the same shift, so the session (and its chat history)
// continues across it via a soft shift. That's what lets the DJ run a thread or
// call back to a track from earlier in the hour. Only two things hard-roll to a
// clean slate (with a handoff line): a genuine show boundary (a scheduled
// program begins, ends, or changes — `show:<id>` in the old or new key) and the
// 4h MAX_SESSION_MS safety cap.
export async function maybeRoll(ctx: any): Promise<any> {
  if (!_session) return start(ctx);
  const nextKey = sessionKeyFor(ctx);
  const aged = Date.now() - new Date(_session.startedAt).getTime() > MAX_SESSION_MS;
  if (_session.key === nextKey && !aged) return _session;

  const bothAuto = _session.key.startsWith('auto:') && nextKey.startsWith('auto:');
  if (bothAuto && !aged) return softShift(ctx, nextKey);

  const prev = _session;
  await end();
  const next = start(ctx, buildHandoff(prev));
  stampRolledFrom(next, prev);
  await persist();
  return next;
}

// After a hard roll, record whether the on-air PERSONA changed so a caller can
// air a two-voice mic-pass (broadcast/dj-agent.runPersonaHandoff): the outgoing
// DJ signs off in their own voice, the incoming DJ acknowledges in theirs. Same
// persona across a show boundary (e.g. a host's show ends but they stay on as
// the active persona) → no on-air handoff; the existing text handoff already
// covers continuity. The flag lives on the PERSISTED session, so a controller
// restart between roll and airing can't double-fire, and either maybeRoll call
// site (hourly cron at :00 or the first track-start after the boundary) can
// trigger it. Session.ts stays free of queue/TTS imports (no cycle): callers
// read pendingHandoff() and drive the runner.
function stampRolledFrom(next: any, prev: any) {
  const prevId = prev?.persona?.id ?? null;
  const nextId = next?.persona?.id ?? null;
  next.handoffAired = false;
  next.rolledFrom = (prevId && nextId && prevId !== nextId)
    ? {
        personaId: prevId,
        personaName: prev?.persona?.name ?? null,
        showName: prev?.show?.name ?? null,   // show that just ended, or null for an auto block
      }
    : null;
}

// The pending on-air handoff for the live session (outgoing persona metadata),
// or null when there's nothing to air (no persona change, or already aired).
export function pendingHandoff(): { personaId: string; personaName: string | null; showName: string | null } | null {
  if (!_session?.rolledFrom || _session.handoffAired) return null;
  return _session.rolledFrom;
}

// Mark the handoff aired so it fires at most once. Called up front by the runner
// (before generating/airing) so a mid-way failure can't retry into the middle
// of the new show — the existing text handoff is the floor.
export function markHandoffAired() {
  if (!_session) return;
  _session.handoffAired = true;
  schedulePersist();
}

// --- Programme episode state (broadcast/programme.ts) -----------------------
// Same persistence contract as handoffAired: state rides the session file so a
// controller restart mid-episode resumes the plan and never double-airs a beat.

export function getProgramme(): any {
  return _session?.programme || null;
}

export function attachProgramme(programme: any) {
  if (!_session) return;
  _session.programme = programme;
  schedulePersist();
}

// Flip one beat flag (e.g. 'intro', 'outro', 'feature:0'). Called BEFORE the
// beat generates/airs — the markHandoffAired idempotency pattern.
export function markProgrammeBeat(beat: string) {
  if (!_session?.programme) return;
  _session.programme.beats = _session.programme.beats || {};
  _session.programme.beats[beat] = true;
  schedulePersist();
}

// Soft continuation across an autonomous daypart/mood turnover: same session id,
// same messages, refreshed identity + scenario. The shift is marked on the
// timeline as a `scenario` turn (filtered out of the agent window like other
// scenario turns, so it adds no prompt noise). No archive, no handoff — the
// running history simply carries forward and the existing WINDOW_TURNS window
// now spans the boundary.
function softShift(ctx: any, nextKey: string): any {
  _session.key = nextKey;
  _session.scenario = scenarioOf(ctx);
  const sc = _session.scenario;
  const label = [
    sc.period,
    sc.mood ? `mood ${sc.mood}` : null,
    sc.weather ? `weather ${sc.weather}` : null,
  ].filter(Boolean).join(', ');
  appendTurn({ role: 'event', kind: 'scenario', text: `Shift continues — now ${label}.` });
  logEvent('session.shift', { sessionId: _session.id, key: _session.key });
  return _session;
}

// The bounded chat window fed to the DJ agent — handoff + the last N turns,
// mapped to AI SDK message roles. The full log stays on disk for the UI.
// Consecutive same-role turns are coalesced because some providers (Anthropic)
// require strictly alternating user/assistant messages.
//
// Four turn kinds get filtered out of the window because they derail the
// picker agent in long sessions:
//
// - `scenario` events (controller restart notes, session boundaries) — infra
//   noise, not part of the DJ's conversation. Every restart leaves "Controller
//   restarted — session resumed" in the window, eventually appearing 3-4
//   times in a single coalesced user message.
//
// - `kind: 'play'` track turns ("▶ Title — Artist") — redundant. Every pick
//   event already contains the current AND previous track ("Now playing X.
//   Pick the next track (after Y)..."), and recently-played TRACKS are filtered
//   at the tool layer (recentIds/recentKeys in buildPickerTools) so they can't
//   be re-picked regardless.
//
// - `kind: 'sfx'` cue turns (queue.playSfx records the effect NAME as a turn) —
//   an audio-production cue, not conversation. Left in, a bare effect name like
//   "whoosh" coalesces into the assistant block and reads as a word the DJ
//   spoke; the effect already aired, so the picker gains nothing from seeing it.
//
// - OLD `kind: 'pick'` events (role='event') — the "Now playing X. Pick the
//   next track" user-side instruction is kept only for the LATEST pick.
//   Previous ones were already answered and just add ambiguity ("which of
//   these 11 'pick next' requests am I responding to?"). Without this filter,
//   gemini's reliability drops from 5/5 short → 2-3/5 long in the
//   picker-test.mjs LONG benchmark, with "No output generated" failures.
//
// The DJ's own reasons (role='dj' kind='pick') stay — but only the most recent
// RATIONALE_WINDOW of them. Each one is the agent's 12-word scratchpad ("Punjabi
// thread continues, …"); left unbounded, ~15-20 accumulate in the window and the
// agent reads its own running commentary as a mandate to keep the thread going
// (one artist re-airing every ~1.2h). Keeping the last few preserves short-term
// "what did I just play" memory without the momentum. Track-recency is enforced
// at the tool layer regardless (recentIds/recentKeys in buildPickerTools), so
// trimming these costs the picker no track-level anti-repeat coverage.
export function windowMessages() {
  if (!_session) return [];
  const raw: any[] = [];
  if (_session.handoff) {
    raw.push({ role: 'user', content: `[Continuing on air from ${_session.handoff}]` });
  }
  const recent = _session.messages.slice(-WINDOW_TURNS);
  // Find the index of the most-recent pick-event user message — older ones
  // are filtered, this one is the current ask we want the agent to respond to.
  let lastPickEventIdx = -1;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].role === 'event' && recent[i].kind === 'pick') { lastPickEventIdx = i; break; }
  }
  // Keep only the most-recent RATIONALE_WINDOW dj/pick rationales — older ones
  // are the thread-momentum noise we want gone.
  const keepRationaleIdx = new Set<number>();
  for (let i = recent.length - 1, kept = 0; i >= 0 && kept < RATIONALE_WINDOW; i--) {
    if (recent[i].role === 'dj' && recent[i].kind === 'pick') { keepRationaleIdx.add(i); kept++; }
  }
  for (let i = 0; i < recent.length; i++) {
    const m = recent[i];
    if (!m.text) continue;
    if (m.kind === 'scenario') continue;  // infra noise
    if (m.kind === 'play') continue;       // redundant — current track is in the pick event
    if (m.kind === 'sfx') continue;        // audio-production cue, not conversation — bare effect name reads as spoken
    if (m.role === 'event' && m.kind === 'pick' && i !== lastPickEventIdx) continue;  // old pick asks
    if (m.role === 'dj' && m.kind === 'pick' && !keepRationaleIdx.has(i)) continue;   // stale pick rationales
    const role = (m.role === 'dj' || m.role === 'segment') ? 'assistant' : 'user';
    // A dj/pick turn's text is the agent's private pick rationale (object.reason),
    // not words it spoke on air. Coalescing (below) would otherwise glue it into
    // the same assistant block as real spoken segments, leaving the picker unable
    // to tell its own scratchpad from its broadcast voice. Mark it so the role of
    // each line stays unambiguous even after coalescing.
    //
    // Same identity guard for a turn VOICED BY A DIFFERENT PERSONA: the handoff
    // sign-off is spoken by the outgoing DJ but stored in the new session
    // (dj-agent.runPersonaHandoff tags it with the speaker's id + name), and a
    // guest co-host's segments land the same way (the speaker rotation stamps
    // every rotated announce with the speaker's id). Untagged they would read
    // as the session persona's own words — name the real speaker instead.
    const foreignSpeaker = (m.role === 'segment'
      && m.meta?.personaId
      && m.meta.personaId !== _session.persona?.id)
      ? (m.meta.personaName || 'another host')
      : null;
    // Model-only coaching clauses ride in meta.promptSuffix so the UI-facing
    // turn text stays a clean factual line (the /admin/dash booth log renders
    // turns verbatim). Re-joined here — the model sees the full message.
    const text = m.meta?.promptSuffix ? `${m.text}${m.meta.promptSuffix}` : m.text;
    const content = (m.role === 'dj' && m.kind === 'pick')
      ? `(pick note to self — not aired) ${text}`
      : foreignSpeaker
        ? `(${foreignSpeaker} said this on air — their words, not yours) ${text}`
        : text;
    raw.push({ role, content });
  }
  const out: any[] = [];
  for (const msg of raw) {
    const last = out[out.length - 1];
    if (last && last.role === msg.role) last.content += '\n' + msg.content;
    else out.push({ ...msg });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// Boot recovery — resume the persisted session if its key still matches the
// current context, otherwise archive it and start fresh.
export async function recover(ctx: any): Promise<any> {
  if (existsSync(config.session.currentFile)) {
    try {
      const stored = JSON.parse(await readFile(config.session.currentFile, 'utf8'));
      if (stored?.id && !stored.endedAt && stored.key === sessionKeyFor(ctx)
          && Array.isArray(stored.messages)) {
        _session = stored;
        appendTurn({ role: 'event', kind: 'scenario', text: 'Controller restarted — session resumed.' });
        return _session;
      }
      if (stored?.id) {
        stored.endedAt = stored.endedAt || new Date().toISOString();
        await archive(stored);
      }
    } catch {}
  }
  return start(ctx);
}
