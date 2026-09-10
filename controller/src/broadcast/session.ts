// Stream session: the DJ's current run as a chat history of timestamped turns,
// which broadcast/dj-agent.js reads a bounded window of. Persisted to
// state/session.json; archived to state/sessions/<id>.json on roll.

import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import * as settings from '../settings.js';
import { logEvent } from '../observability/events.js';
import type { getFullContext } from '../context.js';
import { promptMemoryEntries, type PromptMemoryEntry } from './prompt-memory.js';
import { nextShowBoundaryMs } from './show-boundary.js';

// Type-only import, erased at runtime, so no cycle with context.ts.
export type SessionContext = Awaited<ReturnType<typeof getFullContext>>;

interface Scenario {
  period: string | null;
  vibe: string | null;
  mood: string | null;
  weather: string | null;
  festival: string | null;
}

// A few keys are read by the window builder; anything else rides through.
export interface TurnMeta {
  personaId?: string;
  personaName?: string;
  promptSuffix?: string;
  [k: string]: unknown;
}

interface Turn {
  t: string;
  role: string;
  kind: string;
  text: string;
  meta: TurnMeta;
}

interface ProgrammePlan {
  angle?: string | null;
  features?: Array<{ topic?: string; kind?: string | null }>;
  introNote?: string | null;
  outroNote?: string | null;
  [k: string]: unknown;
}

export interface ProgrammeState {
  status: 'pending' | 'ok' | 'fallback';
  plan: ProgrammePlan | null;
  beats?: Record<string, boolean>;
  introAiredAt: string | null;
}

// Stamped on a hard roll so a caller can air the two-voice mic-pass.
export interface RolledFrom {
  personaId: string;
  personaName: string | null;
  showName: string | null;
  // When the roll fired (epoch ms), so a mic-pass that never found a boundary
  // expires instead of airing hours late. Absent reads as fresh. Not the
  // context's `at`.
  at?: number;
  /** A single-host acknowledgement for two adjacent scheduled shows. */
  sameHost?: boolean;
}

// A mic-pass armed while the final outgoing track is on air. Look-ahead is
// allowed to select the first incoming-show track, but it must not make that
// show live early. This record therefore belongs to the outgoing session until
// the real clock rolls it.
export interface BoundaryHandoff extends RolledFrom {
  incomingPersonaId: string;
  incomingPersonaName: string | null;
  incomingShowName: string | null;
  targetKey: string;
  boundaryAt: number | null;
  contextAt?: string;
  finalTrack?: { id: string | null; title: string | null; artist: string | null } | null;
  /** Rendered into the queue, but not confirmed at the stream edge yet. */
  queued?: boolean;
  aired: boolean;
  /** Incoming episode state prepared without making that show live early. */
  programme?: ProgrammeState | null;
}

// Also the on-disk shape of session.json.
interface Session {
  id: string;
  kind: 'show' | 'auto';
  key: string;
  startedAt: string;
  // The moment the key/persona were resolved FOR (context's `at`); a look-ahead
  // roll puts it ahead of startedAt. maybeRoll refuses an older moment
  // (rollIsBackward); absent, the guard never blocks.
  ctxAt?: string;
  endedAt: string | null;
  show: { id?: string; name?: string; topic?: string } | null;
  persona: { id: string; name: string } | null;
  scenario: Scenario;
  handoff: string | null;
  programme: ProgrammeState | null;
  messages: Turn[];
  handoffAired?: boolean;
  rolledFrom?: RolledFrom | null;
  boundaryHandoff?: BoundaryHandoff | null;
}

const MAX_SESSION_MS = 4 * 60 * 60 * 1000;  // safety cap — roll even if key is stable
const WINDOW_TURNS = 40;                    // turns fed to the agent
// Hard bound on the messages array: persist() rewrites the whole array per turn,
// so unbounded growth is O(n^2). Far above WINDOW_TURNS, so the agent never sees
// the trim.
const MAX_TURNS = 500;
const RATIONALE_WINDOW = 3;                 // most-recent dj/pick reasons kept in the window (anti-thread-momentum)
const PERSIST_DEBOUNCE_MS = 1000;

let _session: Session | null = null;
let _writeTimer: NodeJS.Timeout | null = null;
// A queued handoff survives a restart in session.json, while its WAVs do not.
// This flag lets pendingHandoff() offer that durable record for one re-render
// only after recovery; a live process already has the queue entry and must not
// create a duplicate.
let _resumedQueuedHandoff = false;

function mintId() {
  return 'sess_' + randomBytes(4).toString('hex');
}

// Identity of the run. An autonomous block's key changes on period/mood, but
// maybeRoll() treats that as a soft shift, not a hard roll.
export function sessionKeyFor(ctx: SessionContext) {
  if (ctx?.activeShow?.id) return `show:${ctx.activeShow.id}`;
  return `auto:${ctx?.time?.period || 'unknown'}:${ctx?.dominantMood || 'none'}`;
}

// The moment a context describes. A missing/invalid `at` reads as now.
export function contextDate(ctx: { at?: unknown } | null | undefined): Date {
  const raw = ctx?.at;
  if (typeof raw !== 'string') return new Date();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

// Whether a pending mic-pass has waited too long to be worth airing. A missing
// stamp reads as fresh, so an in-flight handoff across a deploy still airs.
export function handoffIsStale(at: unknown, now: number, maxAgeMs: number): boolean {
  if (typeof at !== 'number' || !Number.isFinite(at)) return false;
  return now - at > maxAgeMs;
}

// Whether a candidate context is OLDER than the moment the live session was
// resolved for: accepting it would roll back across a boundary the look-ahead
// already crossed. Missing/garbage stamps yield false — never block on bad data.
export function rollIsBackward(ctxDate: Date, sessionCtxAt: unknown): boolean {
  const at = typeof sessionCtxAt === 'string' ? Date.parse(sessionCtxAt) : NaN;
  if (!Number.isFinite(at)) return false;
  return ctxDate.getTime() < at;
}

function scenarioOf(ctx: SessionContext): Scenario {
  const w = ctx?.weather?.condition;
  return {
    period: ctx?.time?.period || null,
    vibe: ctx?.time?.vibe || null,
    mood: ctx?.dominantMood || null,
    weather: w && w !== 'unknown' ? w : null,
    festival: ctx?.festival?.name || null,
  };
}

function scenarioText(s: Session) {
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

// Continuity summary carried into the next session on a HARD roll. Identity only
// (#1479): never carry raw prior speech, and never add the recently-aired track
// list — titles in the new picker's prompt window bias it toward repeats.
function buildHandoff(prev: Session | null): string | null {
  if (!prev) return null;
  const parts = [
    prev.kind === 'show'
      ? `the show "${prev.show?.name}"`
      : `a ${prev.scenario?.period || ''} block`,
  ];
  if (prev.persona?.name) parts.push(`hosted as ${prev.persona.name}`);
  if (prev.scenario?.mood) parts.push(`mood ${prev.scenario.mood}`);
  return parts.join(' — ');
}

async function persist() {
  if (!_session) return;
  try {
    // Atomic: a crash mid-write must leave the previous snapshot, not a stub.
    await writeFileAtomic(config.session.currentFile, JSON.stringify(_session, null, 2));
  } catch {}
}

function schedulePersist() {
  if (_writeTimer) return;
  _writeTimer = setTimeout(() => { _writeTimer = null; persist(); }, PERSIST_DEBOUNCE_MS);
}

async function archive(s: Session | null) {
  if (!s?.id) return;
  try {
    await mkdir(config.session.dir, { recursive: true });
    await writeFileAtomic(`${config.session.dir}/${s.id}.json`, JSON.stringify(s, null, 2));
  } catch {}
}

// The persona currently ON AIR. Prefer this over settings.getEffectivePersona()
// for anything voicing a line: the session leads the weekly grid by up to
// PICK_SHOW_LOOKAHEAD_SEC after a look-ahead roll, and inside that window the
// session is right. Falls back to the grid.
export function onAirPersona() {
  const id = _session?.persona?.id;
  return (id && settings.resolvePersonaById(id)) || settings.getEffectivePersona();
}

export function getSession() {
  return _session;
}

// Aired speech of the current editorial session, newest first. A hard roll is
// the prompt-memory boundary by construction; Queue.djLog stays station-wide.
export function promptMemory(): PromptMemoryEntry[] {
  return promptMemoryEntries(_session?.messages || [], _session?.persona?.id ?? null);
}

// The view of the session a hard roll just archived. Read only by the outgoing
// sign-off, which runs after maybeRoll has replaced the live session. In-memory
// only. Never offered to the incoming greeting (#1479).
let _priorPromptMemory: PromptMemoryEntry[] = [];

export function priorPromptMemory(): PromptMemoryEntry[] {
  return _priorPromptMemory;
}

// `role` in event|dj|track|segment; `kind` is the turn type
// (scenario|pick|request|play|link|station-id|hourly|weather|...).
export function appendTurn({ role, kind, text, meta = {} }: { role: string; kind: string; text?: string; meta?: TurnMeta }) {
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
export function start(ctx: SessionContext, handoff: string | null = null): Session {
  _resumedQueuedHandoff = false;
  // Resolve the persona for the moment the CONTEXT describes, not the wall
  // clock: `show` below comes from ctx.activeShow at that (possibly future)
  // moment, and a persona resolved at a different one makes stampRolledFrom
  // compare the outgoing persona against itself and suppress the mic-pass.
  const at = contextDate(ctx);
  const persona = settings.getEffectivePersona(at);
  _session = {
    id: mintId(),
    kind: ctx?.activeShow ? 'show' : 'auto',
    key: sessionKeyFor(ctx),
    startedAt: new Date().toISOString(),
    ctxAt: at.toISOString(),
    endedAt: null,
    show: ctx?.activeShow
      ? { id: ctx.activeShow.id, name: ctx.activeShow.name, topic: ctx.activeShow.topic }
      : null,
    persona: persona ? { id: persona.id, name: persona.name } : null,
    scenario: scenarioOf(ctx),
    handoff: handoff || null,
    // Attached lazily by broadcast/programme.ts; persisted so a restart
    // mid-episode can't re-plan or double-air a beat.
    programme: null,
    messages: [],
  };
  // Debounced persist only. An immediate unawaited write here could land after
  // maybeRoll's awaited post-stampRolledFrom persist() and leave a stale file.
  appendTurn({ role: 'event', kind: 'scenario', text: scenarioText(_session) });
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

// Keep the live session or roll to a fresh one. Only a genuine show boundary or
// the 4h cap hard-rolls; an autonomous daypart/mood turnover is a soft shift
// that keeps the chat history.
export async function maybeRoll(ctx: SessionContext): Promise<Session> {
  if (!_session) return start(ctx);
  const nextKey = sessionKeyFor(ctx);
  const aged = Date.now() - new Date(_session.startedAt).getTime() > MAX_SESSION_MS;
  if (_session.key === nextKey && !aged) return _session;

  // A key change that only exists because the CALLER's clock is behind the
  // look-ahead roll is not a boundary. Rolling here would archive the
  // just-started session and hand onAirPersona() back to the outgoing DJ.
  if (!aged && rollIsBackward(contextDate(ctx), _session.ctxAt)) return _session;

  const bothAuto = _session.key.startsWith('auto:') && nextKey.startsWith('auto:');
  if (bothAuto && !aged) return softShift(ctx, nextKey);

  const prev = _session;
  // An armed final-track handoff may already have voiced (or, in
  // between-tracks mode, rendered and queued) this exact changeover. Do not
  // create a second mic-pass when the station clock reaches the boundary.
  const handoffAlreadyCovered = prev.boundaryHandoff?.aired
    && prev.boundaryHandoff.targetKey === nextKey;
  const pendingBoundaryHandoff = prev.boundaryHandoff
    && !prev.boundaryHandoff.aired
    && prev.boundaryHandoff.targetKey === nextKey
    ? prev.boundaryHandoff
    : null;
  const boundaryProgramme = prev.boundaryHandoff?.targetKey === nextKey
    ? prev.boundaryHandoff.programme ?? null
    : null;
  // Snapshot before end()/start() replace the live session — the outgoing DJ's
  // sign-off is generated after this returns (see priorPromptMemory above).
  _priorPromptMemory = promptMemoryEntries(prev.messages, prev.persona?.id ?? null);
  await end();
  const next = start(ctx, buildHandoff(prev));
  if (boundaryProgramme) next.programme = boundaryProgramme;
  stampRolledFrom(next, prev);
  if (handoffAlreadyCovered) next.handoffAired = true;
  if (pendingBoundaryHandoff) {
    next.boundaryHandoff = pendingBoundaryHandoff;
    next.rolledFrom = null;
    next.handoffAired = true;
    _resumedQueuedHandoff = false;
  }
  await persist();
  return next;
}

// After a hard roll, record whether the on-air PERSONA changed so a caller can
// air the two-voice mic-pass. Unchanged persona means no on-air handoff. The
// flag is PERSISTED so a restart between roll and airing can't double-fire.
// Callers drive the runner off pendingHandoff(); no queue/TTS import here.
function stampRolledFrom(next: Session, prev: Session) {
  const prevId = prev?.persona?.id ?? null;
  const nextId = next?.persona?.id ?? null;
  const sameHostShowChange = !!prevId && !!nextId && prevId === nextId
    && prev.key.startsWith('show:') && next.key.startsWith('show:')
    && settings.get().djBehaviour.sameHostAcknowledgement;
  next.handoffAired = false;
  next.rolledFrom = (prevId && nextId && (prevId !== nextId || sameHostShowChange))
    ? {
        personaId: prevId,
        personaName: prev?.persona?.name ?? null,
        showName: prev?.show?.name ?? null,   // null for an auto block
        at: Date.now(),
        sameHost: sameHostShowChange,
      }
    : null;
}

// The pending on-air handoff for the live session (outgoing persona metadata),
// or null when there's nothing to air (no persona change, or already aired).
export function pendingHandoff(): RolledFrom | BoundaryHandoff | null {
  if (_session?.boundaryHandoff && !_session.boundaryHandoff.aired
      && (!_session.boundaryHandoff.queued || _resumedQueuedHandoff)) {
    return _session.boundaryHandoff;
  }
  if (!_session?.rolledFrom || _session.handoffAired) return null;
  return _session.rolledFrom;
}

// Mark the handoff heard at the stream edge. A final-track handoff is queued
// first, so a restart before this point can regenerate its lost audio.
export function markHandoffAired() {
  if (!_session) return;
  if (_session.boundaryHandoff && !_session.boundaryHandoff.aired) {
    _session.boundaryHandoff.queued = false;
    _session.boundaryHandoff.aired = true;
    _resumedQueuedHandoff = false;
    schedulePersist();
    return;
  }
  _session.handoffAired = true;
  schedulePersist();
}

// The voice chain accepted a handoff pair, but its live-edge marker has not
// fired. This is durable so a controller restart can regenerate the pair;
// pendingHandoff() intentionally hides it during this process because queue.ts
// still owns the original rendered clips.
export function markHandoffQueued() {
  if (!_session?.boundaryHandoff || _session.boundaryHandoff.aired) return;
  _session.boundaryHandoff.queued = true;
  _resumedQueuedHandoff = false;
  schedulePersist();
}

export function getBoundaryProgramme(): ProgrammeState | null {
  return _session?.boundaryHandoff?.programme ?? null;
}

export function attachBoundaryProgramme(programme: ProgrammeState) {
  if (!_session?.boundaryHandoff || _session.boundaryHandoff.aired) return;
  _session.boundaryHandoff.programme = programme;
  schedulePersist();
}

// Arm a mic-pass for the final outgoing track without rolling the live
// session. Returns false unless the look-ahead context crosses a genuine show
// boundary and changes the effective persona.
export function armBoundaryHandoff(
  ctx: SessionContext,
  finalTrack: { id?: string | null; title?: string | null; artist?: string | null } | null = null,
): boolean {
  if (!_session || _session.boundaryHandoff) return false;
  const targetKey = sessionKeyFor(ctx);
  if (targetKey === _session.key) return false;
  if (!_session.key.startsWith('show:') && !targetKey.startsWith('show:')) return false;
  const incoming = settings.getEffectivePersona(contextDate(ctx));
  const outgoingId = _session.persona?.id;
  if (!outgoingId || !incoming?.id || outgoingId === incoming.id) return false;
  const boundaryAt = nextShowBoundaryMs(Date.now(), 6 * 3600);
  _session.boundaryHandoff = {
    personaId: outgoingId,
    personaName: _session.persona?.name ?? null,
    showName: _session.show?.name ?? null,
    incomingPersonaId: incoming.id,
    incomingPersonaName: incoming.name ?? null,
    incomingShowName: ctx?.activeShow?.name ?? null,
    targetKey,
    boundaryAt,
    contextAt: typeof ctx?.at === 'string' ? ctx.at : new Date(boundaryAt ?? Date.now()).toISOString(),
    finalTrack: finalTrack ? {
      id: finalTrack.id ?? null,
      title: finalTrack.title ?? null,
      artist: finalTrack.artist ?? null,
    } : null,
    aired: false,
    at: Date.now(),
  };
  schedulePersist();
  return true;
}

export function boundaryHandoffReadyForTrack(
  track: { id?: string | null; title?: string | null; artist?: string | null } | null,
): boolean {
  const handoff = _session?.boundaryHandoff;
  if (!handoff || handoff.queued || handoff.aired || !track) return false;
  const expected = handoff.finalTrack;
  // Older persisted records did not identify the final track. Preserve their
  // fail-open recovery rather than stranding an armed handoff forever.
  if (!expected) return true;
  if (expected.id && track.id) return expected.id === track.id;
  return expected.title === (track.title ?? null) && expected.artist === (track.artist ?? null);
}

export function boundaryHandoffContextAt(): Date | null {
  const raw = _session?.boundaryHandoff?.contextAt;
  if (typeof raw !== 'string') return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

// Generic roll/drain callers must not publish an armed pair before the
// now-playing transition confirms the recorded final track. Older persisted
// records have no identity and retain their established fail-open behaviour.
export function boundaryHandoffAwaitsTrack(): boolean {
  const handoff = _session?.boundaryHandoff;
  return !!handoff && !handoff.queued && !handoff.aired && !!handoff.finalTrack;
}

// Once a final-track handoff has claimed the outgoing show's air, no ordinary
// speech from its stale roster may cross the boundary.
export function handoffInProgress(): boolean {
  return !!(_session?.boundaryHandoff?.queued || _session?.boundaryHandoff?.aired);
}

// The deferred between-tracks handoff must not air merely because an estimate
// was early; it waits for the first real seam at or after this instant.
export function handoffBoundaryAt(): number | null {
  const at = _session?.boundaryHandoff?.boundaryAt;
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

// Compact operational state for /debug. The full session remains available
// there too; this is deliberately the answer to "is a handoff waiting?".
export function boundaryHandoffStatus() {
  const h = _session?.boundaryHandoff;
  if (!h) return null;
  return {
    state: h.aired ? 'aired' : h.queued ? 'queued' : 'armed',
    from: h.personaName,
    to: h.incomingPersonaName,
    show: h.incomingShowName,
    boundaryAt: h.boundaryAt,
    recovered: _resumedQueuedHandoff,
  };
}

// --- Programme episode state (broadcast/programme.ts) -----------------------
// Same persistence contract as handoffAired: state rides the session file so a
// controller restart mid-episode resumes the plan and never double-airs a beat.

export function getProgramme(): ProgrammeState | null {
  return _session?.programme || null;
}

export function attachProgramme(programme: ProgrammeState) {
  if (!_session) return;
  _session.programme = programme;
  schedulePersist();
}

// Flip one beat flag ('intro', 'outro', 'feature:0'). Called BEFORE the beat
// airs, like markHandoffAired.
export function markProgrammeBeat(beat: string) {
  if (!_session?.programme) return;
  _session.programme.beats = _session.programme.beats || {};
  _session.programme.beats[beat] = true;
  schedulePersist();
}

// Soft continuation across an autonomous daypart/mood turnover: same session id
// and messages, refreshed identity + scenario. No archive, no handoff.
function softShift(ctx: SessionContext, nextKey: string): Session {
  const s = _session!;  // maybeRoll only reaches here with a live session
  s.key = nextKey;
  s.scenario = scenarioOf(ctx);
  const sc = s.scenario;
  const label = [
    sc.period,
    sc.mood ? `mood ${sc.mood}` : null,
    sc.weather ? `weather ${sc.weather}` : null,
  ].filter(Boolean).join(', ');
  appendTurn({ role: 'event', kind: 'scenario', text: `Shift continues — now ${label}.` });
  logEvent('session.shift', { sessionId: s.id, key: s.key });
  return s;
}

// The bounded chat window fed to the DJ agent: handoff + the last N turns, mapped
// to AI SDK roles. Consecutive same-role turns are coalesced because some
// providers (Anthropic) require strictly alternating user/assistant messages.
//
// Filtered out because they derail the picker in long sessions: `scenario`
// events (infra noise), `play` turns (the pick event already names the tracks),
// `sfx` cues (they read as words the DJ spoke), and all but the LATEST `pick`
// event (older asks are already answered and add ambiguity). The DJ's own
// `dj`/`pick` rationales are kept to the most recent RATIONALE_WINDOW — left
// unbounded, the agent reads its own commentary as a mandate to keep the thread.
export function windowMessages() {
  if (!_session) return [];
  const raw: { role: 'user' | 'assistant'; content: string }[] = [];
  if (_session.handoff) {
    raw.push({ role: 'user', content: `[Continuing on air from ${_session.handoff}]` });
  }
  const recent = _session.messages.slice(-WINDOW_TURNS);
  // The current ask the agent should respond to; older pick events are filtered.
  let lastPickEventIdx = -1;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].role === 'event' && recent[i].kind === 'pick') { lastPickEventIdx = i; break; }
  }
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
    // Coalescing below would glue a private pick rationale, or a line voiced by
    // another persona (a sign-off stored in the new session, a guest co-host's
    // segment), into the same assistant block as the session persona's own
    // speech. Tag both so the speaker stays unambiguous after coalescing.
    const foreignSpeaker = (m.role === 'segment'
      && m.meta?.personaId
      && m.meta.personaId !== _session.persona?.id)
      ? (m.meta.personaName || 'another host')
      : null;
    // Model-only coaching clauses ride in meta.promptSuffix so the booth log's
    // verbatim turn text stays clean. Re-joined here for the model.
    const text = m.meta?.promptSuffix ? `${m.text}${m.meta.promptSuffix}` : m.text;
    const content = (m.role === 'dj' && m.kind === 'pick')
      ? `(pick note to self — not aired) ${text}`
      : foreignSpeaker
        ? `(${foreignSpeaker} said this on air — their words, not yours) ${text}`
        : text;
    raw.push({ role, content });
  }
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const msg of raw) {
    const last = out[out.length - 1];
    if (last && last.role === msg.role) last.content += '\n' + msg.content;
    else out.push({ ...msg });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// Boot recovery: resume the persisted session if its key still matches, else
// archive it and start fresh.
export async function recover(ctx: SessionContext): Promise<Session> {
  if (existsSync(config.session.currentFile)) {
    try {
      const stored = JSON.parse(await readFile(config.session.currentFile, 'utf8'));
      if (stored?.id && !stored.endedAt && stored.key === sessionKeyFor(ctx)
          && Array.isArray(stored.messages)) {
        _session = stored as Session;
        _resumedQueuedHandoff = _session.boundaryHandoff?.queued === true;
        appendTurn({ role: 'event', kind: 'scenario', text: 'Controller restarted — session resumed.' });
        return _session;
      }
      // The restart happened after the station clock crossed the boundary, so
      // the stored outgoing-session key no longer matches. Preserve the
      // boundary record on the fresh incoming session: an armed/queued pair is
      // regenerated because its WAVs lived only in memory, while an aired pair
      // transfers its programme and covered-intro stamp without reopening the
      // show.
      if (stored?.boundaryHandoff
          && stored.boundaryHandoff.targetKey === sessionKeyFor(ctx)) {
        const next = start(ctx, buildHandoff(stored as Session));
        const boundary = stored.boundaryHandoff as BoundaryHandoff;
        next.programme = boundary.programme ?? null;
        if (boundary.aired) {
          stampRolledFrom(next, stored as Session);
          next.handoffAired = true;
          _resumedQueuedHandoff = false;
        } else {
          next.boundaryHandoff = boundary;
          next.rolledFrom = null;
          next.handoffAired = true;
          _resumedQueuedHandoff = boundary.queued === true;
        }
        await persist();
        return next;
      }
      if (stored?.id) {
        stored.endedAt = stored.endedAt || new Date().toISOString();
        await archive(stored);
      }
    } catch {}
  }
  return start(ctx);
}
