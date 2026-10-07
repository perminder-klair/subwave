// Stream session: the DJ's current run as a chat history of timestamped turns,
// which broadcast/dj-agent.js reads a bounded window of. Persisted to
// state/session.json; archived to state/sessions/<id>.json on roll.

import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { writeFileAtomic, writeFileAtomicSync } from '../util/atomic-file.js';
import * as settings from '../settings.js';
import { logEvent } from '../observability/events.js';
import type { getFullContext } from '../context.js';
import { promptMemoryEntries, type PromptMemoryEntry } from './prompt-memory.js';
import { nextShowBoundaryMs, showRunContinues, showTakeoverStartedAt } from './show-boundary.js';
import type { Persona } from './queue/types.js';
import { leaningsBlindPickReason } from './dj-agent/leanings-review.js';

// Type-only import, erased at runtime, so no cycle with context.ts.
export type SessionContext = Awaited<ReturnType<typeof getFullContext>> & { episodeOccurrenceId?: string | null };

export interface HostSpeechStamp {
  readonly showKey: string;
  readonly personaId: string | null;
  readonly revision: number;
}

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

interface ProgrammeEpisode {
  status: 'pending' | 'ok' | 'fallback';
  preparationSubject?: string;
  preparationOccurrence?: { id: string; endsAt: number };
  plan: ProgrammePlan | null;
  beats?: Record<string, boolean>;
  introAiredAt: string | null;
}

export interface ProgrammeState extends ProgrammeEpisode {
  interruptedEpisodes?: ProgrammeEpisode[];
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
  /** Saved source data for the outgoing sign-off, never its raw speech. */
  episodeEditorial?: string;
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
  takeoverStartedAt?: number | null;
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
  /** Episode owner; null means the weekly grid, absent means a legacy session. */
  takeoverStartedAt?: number | null;
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
  hostRevision?: number;
  /** The occurrence which opened this session; same-show takeovers may differ. */
  episodeOccurrenceId?: string | null;
  episodeEditorial?: string;
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
// A queued handoff survives a restart in session.json. queue.json separately
// snapshots the rendered WAV paths and their absolute deadline; this flag lets
// pendingHandoff() offer the durable session record for one re-render after
// recovery only when queue recovery cannot reclaim those clips. A live process
// already has the queue entry and must not create a duplicate.
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
    // Session state is small and some mutations are synchronous commit
    // boundaries. Keep every current-session writer synchronous so an older
    // async rename cannot land after a newer host epoch and roll it backwards.
    writeFileAtomicSync(config.session.currentFile, JSON.stringify(_session, null, 2));
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

function normalizedHostRevision(value: unknown): number {
  const revision = Number(value);
  return Number.isFinite(revision) && revision >= 0 ? Math.floor(revision) : 0;
}

// Refresh the compact host identity without rolling the editorial session. Only
// the same active scheduled show is eligible; a look-ahead session on the other
// side of a real boundary remains authoritative until the clock catches up.
export function refreshHost(at: Date = new Date()): boolean {
  const s = _session;
  if (!s || !s.key.startsWith('show:')) return false;
  const show = settings.resolveActiveShow(at);
  if (!show || `show:${show.id}` !== s.key) return false;
  const persona = settings.getEffectivePersona(at);
  const previousId = s.persona?.id ?? null;
  const nextId = persona?.id ?? null;
  s.hostRevision = normalizedHostRevision(s.hostRevision);
  if (previousId === nextId) return false;
  const previousName = s.persona?.name ?? null;
  s.persona = persona ? { id: persona.id, name: persona.name } : null;
  s.hostRevision += 1;
  appendTurn({
    role: 'event',
    kind: 'scenario',
    text: `Host changed from ${previousName || 'the default DJ'} to ${persona?.name || 'the default DJ'} while the show continues.`,
  });
  logEvent('session.host-refresh', {
    sessionId: s.id, key: s.key, previousPersonaId: previousId, personaId: nextId,
    hostRevision: s.hostRevision,
  });
  // queue.json lands on a shorter debounce. Make the new epoch durable before
  // a freshly stamped queue item can outrun it, including A -> B -> A where
  // persona equality cannot reveal the missed transitions after restart.
  void persist();
  return true;
}

export function captureHostSpeech(at: Date = new Date()): HostSpeechStamp | null {
  refreshHost(at);
  const s = _session;
  if (!s || !s.key.startsWith('show:')) return null;
  return {
    showKey: s.key,
    personaId: s.persona?.id ?? null,
    revision: normalizedHostRevision(s.hostRevision),
  };
}

export function isHostSpeechCurrent(stamp: HostSpeechStamp | null | undefined): boolean {
  if (!stamp) return true;
  refreshHost();
  const s = _session;
  return !!s
    && s.key === stamp.showKey
    && (s.persona?.id ?? null) === stamp.personaId
    && normalizedHostRevision(s.hostRevision) === stamp.revision;
}

// The persona currently ON AIR. Prefer this over settings.getEffectivePersona()
// for anything voicing a line: the session leads the weekly grid by up to
// PICK_SHOW_LOOKAHEAD_SEC after a look-ahead roll, and inside that window the
// session is right. Falls back to the grid.
export function onAirPersona() {
  refreshHost();
  const id = _session?.persona?.id;
  return (id && settings.resolvePersonaById(id)) || settings.getEffectivePersona();
}

export interface AutomaticHostSpeech {
  persona: Persona | null;
  hostSpeech: HostSpeechStamp | null;
}

// Resolve one automatic speaker and its ownership stamp before asynchronous
// generation starts. Ordinary host speech belongs to the current same-show
// host epoch. A rostered guest is independently owned and intentionally
// unstamped; an unexpected speaker is repaired to the on-air host.
export function captureAutomaticHostSpeech(
  selected: Persona | null | undefined = undefined,
  at: Date = new Date(),
): AutomaticHostSpeech {
  const hostSpeech = captureHostSpeech(at);
  const hostPersona = (hostSpeech?.personaId && settings.resolvePersonaById(hostSpeech.personaId))
    || settings.getEffectivePersona(at)
    || null;
  const persona = selected ?? hostPersona;
  if (!hostSpeech || persona?.id === hostSpeech.personaId) return { persona, hostSpeech };
  const guests = settings.getOnAirRoster(at).guests;
  if (guests.some(guest => guest.id === persona?.id)) return { persona, hostSpeech: null };
  return { persona: hostPersona, hostSpeech };
}

// Spend an asynchronously generated host-owned line only if the exact epoch
// that commissioned it is still live. Persona and stamp are cleared with the
// text so a caller cannot relabel old words as the new host.
export function finalizeAutomaticHostSpeech(
  text: string | null | undefined,
  owner: AutomaticHostSpeech,
): { text: string | null; persona: Persona | null; hostSpeech: HostSpeechStamp | null } {
  const present = typeof text === 'string' && text.trim().length > 0;
  const current = !owner.hostSpeech || isHostSpeechCurrent(owner.hostSpeech);
  if (!present || !current) return { text: null, persona: null, hostSpeech: null };
  return { text: text!, persona: owner.persona, hostSpeech: owner.hostSpeech };
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
    takeoverStartedAt: showTakeoverStartedAt(at.getTime()),
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
    hostRevision: 0,
    episodeOccurrenceId: ctx.episodeOccurrenceId,
    episodeEditorial: ctx.episodeEditorial,
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
  const at = contextDate(ctx);
  // A look-ahead context has already advanced ownership; an older caller must
  // not reset it simply because continuity cannot run backwards.
  if (!aged && rollIsBackward(at, _session.ctxAt)) return _session;
  const continuous = _session.key === nextKey && sessionRunContinues(_session, at);
  if (_session.key === nextKey) {
    refreshHost(at);
    if (!aged && continuous) return _session;
  }

  const bothAuto = _session.key.startsWith('auto:') && nextKey.startsWith('auto:');
  if (bothAuto && !aged) return softShift(ctx, nextKey);

  const prev = _session;
  const sameKeyRevision = prev.key === nextKey ? normalizedHostRevision(prev.hostRevision) : 0;
  // An armed final-track handoff may already have voiced (or, in
  // between-tracks mode, rendered and queued) this exact changeover. Do not
  // create a second mic-pass when the station clock reaches the boundary.
  const boundary = prev.boundaryHandoff?.targetKey === nextKey
    && boundaryRunContinues(prev.boundaryHandoff, at) ? prev.boundaryHandoff : null;
  const handoffAlreadyCovered = boundary?.aired;
  const pendingBoundaryHandoff = boundary && !boundary.aired
    ? boundary
    : null;
  const boundaryProgramme = boundary?.programme ?? null;
  // Snapshot before end()/start() replace the live session — the outgoing DJ's
  // sign-off is generated after this returns (see priorPromptMemory above).
  _priorPromptMemory = promptMemoryEntries(prev.messages, prev.persona?.id ?? null);
  await end();
  const next = start(ctx, buildHandoff(prev));
  if (prev.key === nextKey) next.hostRevision = sameKeyRevision;
  carryInterruptedProgramme(next, prev.programme, contextDate(ctx));
  // A continuous 4h cap is still the same episode: keep its plan and aired
  // beats. A prepared incoming programme takes precedence at a real boundary.
  if (boundaryProgramme) next.programme = boundaryProgramme;
  else if (continuous && prev.programme) next.programme = prev.programme;
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
  // A genuine change of show only. The 4h safety cap also hard-rolls, with the
  // key unchanged: without the key check a long show (e.g. 23:00-06:00) had
  // its host "acknowledge a show change" to themself four hours in.
  const sameHostShowChange = !!prevId && !!nextId && prevId === nextId
    && prev.key.startsWith('show:') && next.key.startsWith('show:')
    && prev.key !== next.key
    && settings.get().djBehaviour.sameHostAcknowledgement;
  next.handoffAired = false;
  next.rolledFrom = (prevId && nextId && (prevId !== nextId || sameHostShowChange))
    ? {
        personaId: prevId,
        personaName: prev?.persona?.name ?? null,
        showName: prev?.show?.name ?? null,   // null for an auto block
        at: Date.now(),
        sameHost: sameHostShowChange,
        episodeEditorial: prev.episodeEditorial || '',
      }
    : null;
}

// How long an armed handoff waits for its recorded final track specifically
// to be confirmed on air before giving up on that exact identity. Deliberately
// NOT HANDOFF_MAX_AGE_MS (dj-agent/breaker.ts) — that constant times a
// RENDERED clip's spoken content going stale, a different question. A track
// is a few minutes at most, so several minutes past a boundary still
// unconfirmed means the recorded track was skipped, swapped for a fallback
// pick, or otherwise never played — not that it's merely running long.
const BOUNDARY_TRACK_CONFIRM_MAX_AGE_MS = 6 * 60_000;

// Whether the current boundaryHandoff still expects a SPECIFIC recorded final
// track (armBoundaryHandoff/boundaryHandoffReadyForTrack) and has waited past
// due for it without confirmation. Once queued or aired the identity check
// has already served its purpose and this no longer applies.
function boundaryHandoffTrackOverdue(now: number): boolean {
  const h = _session?.boundaryHandoff;
  if (!h || h.aired || h.queued || !h.finalTrack) return false;
  return handoffIsStale(h.boundaryAt, now, BOUNDARY_TRACK_CONFIRM_MAX_AGE_MS);
}

// Only confirmed playback may replace an overdue final-track identity. Keep
// the replacement identity while rendering so generic pick/roll callers still
// stand down and cannot bypass the confirmed runner's talk placement scope.
function relaxOverdueBoundaryHandoffTrack(
  track: { id?: string | null; title?: string | null; artist?: string | null },
  now: number = Date.now(),
) {
  if (!boundaryHandoffTrackOverdue(now)) return;
  const h = _session!.boundaryHandoff!;
  logEvent('handoff.finalTrackAbandoned', {
    from: h.personaName,
    to: h.incomingPersonaName,
    show: h.incomingShowName,
    boundaryAt: h.boundaryAt,
    finalTrack: h.finalTrack,
  });
  h.contextAt = new Date(now).toISOString();
  h.finalTrack = { id: track.id ?? null, title: track.title ?? null, artist: track.artist ?? null };
  schedulePersist();
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
// An aired boundary record only guards anything BEFORE the roll: it stops the
// outgoing show's stale roster from speaking over the boundary it already
// covered, and tells maybeRoll not to air a second mic-pass. A record carried
// onto the incoming session while still armed/queued (the pair aired after the
// station clock rolled: a late final-track handoff, a between-tracks deferral
// past the boundary, a restart past the boundary) is flipped to aired THERE,
// where its target is the live show itself. It stays for /debug and for its
// programme, but it is history: it must neither hold the air for the whole
// incoming show ("the show handoff has already claimed this boundary" on every
// scheduled segment) nor block arming the next boundary. Seen live after a
// 23:07 restart past a 23:00 boundary: the pair aired at 23:10 and the DJ
// stayed silent for the rest of the show.
function airedOnLiveShow(): boolean {
  const h = _session?.boundaryHandoff;
  return !!(_session && h?.aired && h.targetKey === _session.key);
}

export function markHandoffAired() {
  if (!_session) return;
  if (_session.boundaryHandoff && !_session.boundaryHandoff.aired) {
    const h = _session.boundaryHandoff;
    h.queued = false;
    h.aired = true;
    _resumedQueuedHandoff = false;
    if (h.targetKey === _session.key) {
      // Aired after the roll: the greeting opened this show, so it counts as
      // this session's mic-pass, and the plan prepared for it is this show's.
      if (h.programme && !_session.programme) _session.programme = h.programme;
      _session.handoffAired = true;
      logEvent('handoff.airedAfterRoll', {
        from: h.personaName,
        to: h.incomingPersonaName,
        show: h.incomingShowName,
        boundaryAt: h.boundaryAt,
      });
    }
    schedulePersist();
    return;
  }
  _session.handoffAired = true;
  schedulePersist();
}

// The voice chain accepted a handoff pair, but its live-edge marker has not
// fired. This is durable so a controller restart can reclaim the rendered pair
// from queue.json, or regenerate it if that manifest/audio is unavailable;
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
  // A record aired on this very show is history and gives way to the next one.
  if (!_session || (_session.boundaryHandoff && !airedOnLiveShow())) return false;
  const targetKey = sessionKeyFor(ctx);
  if (targetKey === _session.key) return false;
  if (!_session.key.startsWith('show:') && !targetKey.startsWith('show:')) return false;
  const at = contextDate(ctx);
  const incoming = settings.getEffectivePersona(at);
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
    takeoverStartedAt: showTakeoverStartedAt(at.getTime()),
    finalTrack: finalTrack ? {
      id: finalTrack.id ?? null,
      title: finalTrack.title ?? null,
      artist: finalTrack.artist ?? null,
    } : null,
    aired: false,
    at: Date.now(),
    episodeEditorial: _session.episodeEditorial || '',
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

// Called only by the confirmed-track runner, including a newly armed handoff
// on the track already on air. Read/debug/pick paths must not relax its gate.
export function confirmBoundaryHandoffTrack(
  track: { id?: string | null; title?: string | null; artist?: string | null } | null,
): boolean {
  if (!track) return false;
  relaxOverdueBoundaryHandoffTrack(track);
  return boundaryHandoffReadyForTrack(track);
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
  if (airedOnLiveShow()) return false;
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

export function unexpiredProgrammeEpisodes(programme: ProgrammeState, at: number): ProgrammeEpisode[] {
  const { interruptedEpisodes = [], ...current } = programme;
  const retained = new Map<string, ProgrammeEpisode>();
  for (const episode of [...interruptedEpisodes, current]) {
    const occurrence = episode.preparationOccurrence;
    if (occurrence && occurrence.endsAt > at) retained.set(occurrence.id, episode);
  }
  return [...retained.values()].slice(-16);
}

// Boundary-prepared and continuous-cap objects retain ownership. A fresh
// session can still resume any unexpired occurrence after a roll or restart.
function carryInterruptedProgramme(next: Session, previous: ProgrammeState | null | undefined, at: Date) {
  if (next.programme || !previous) return;
  const retained = unexpiredProgrammeEpisodes(previous, at.getTime());
  if (retained.length) next.programme = { status: 'pending', plan: null, beats: {}, introAiredAt: null, interruptedEpisodes: retained };
}

// Called only for the live preparation occurrence, so look-ahead research
// cannot overwrite the outgoing presenter's source snapshot.
export function rememberEpisodeEditorial(ctx: SessionContext) {
  if (!_session || _session.key !== sessionKeyFor(ctx)) return;
  if (_session.episodeEditorial === ctx.episodeEditorial) return;
  _session.episodeEditorial = ctx.episodeEditorial;
  const handoff = _session.boundaryHandoff;
  if (handoff && handoff.targetKey !== _session.key && !handoff.aired) handoff.episodeEditorial = ctx.episodeEditorial;
  schedulePersist();
}

export function rememberOpeningOccurrence(occurrence: { id: string; endsAt: number }) {
  if (!_session) return;
  const legacyProgramme = _session.programme && !_session.programme.preparationOccurrence && !_session.programme.interruptedEpisodes
    ? _session.programme : null;
  const missing = !_session.episodeOccurrenceId || legacyProgramme;
  _session.episodeOccurrenceId ??= occurrence.id;
  if (legacyProgramme) legacyProgramme.preparationOccurrence = occurrence;
  if (missing) schedulePersist();
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
    // Keep the operator's original reason on disk, but remove preference prose
    // from model history, including sessions written before this guard existed.
    const promptText = m.role === 'dj' && m.kind === 'pick'
      ? leaningsBlindPickReason(m.text, { title: m.meta?.title, artist: m.meta?.artist })
      : m.text;
    const text = m.meta?.promptSuffix ? `${promptText}${m.meta.promptSuffix}` : promptText;
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

function sessionRunContinues(stored: Session, at: Date): boolean {
  return showRunContinues({
    key: stored.key,
    fromMs: new Date(stored.ctxAt ?? stored.startedAt).getTime(),
    toMs: at.getTime(),
    takeoverStartedAt: stored.takeoverStartedAt,
  });
}

function boundaryRunContinues(boundary: BoundaryHandoff, at: Date): boolean {
  const fromMs = boundary.boundaryAt ?? (boundary.contextAt ? new Date(boundary.contextAt).getTime() : null);
  // Older handoff records without an anchor retain their recovery behaviour.
  return fromMs === null || showRunContinues({
    key: boundary.targetKey, fromMs, toMs: at.getTime(),
    takeoverStartedAt: boundary.takeoverStartedAt,
  });
}

// Boot recovery: resume the persisted session if its show run still matches, else
// archive it and start fresh.
export async function recover(ctx: SessionContext): Promise<Session> {
  if (existsSync(config.session.currentFile)) {
    try {
      const stored = JSON.parse(await readFile(config.session.currentFile, 'utf8'));
      if (stored?.id && !stored.endedAt && stored.key === sessionKeyFor(ctx)
          && Array.isArray(stored.messages) && sessionRunContinues(stored, contextDate(ctx))) {
        _session = stored as Session;
        const takeoverRepaired = _session.takeoverStartedAt === undefined;
        if (takeoverRepaired) _session.takeoverStartedAt = showTakeoverStartedAt(contextDate(ctx).getTime());
        const boundary = _session.boundaryHandoff;
        const boundaryRepaired = boundary?.targetKey === _session.key && boundary.takeoverStartedAt === undefined
          && boundaryRunContinues(boundary, contextDate(ctx));
        if (boundaryRepaired) boundary.takeoverStartedAt = _session.takeoverStartedAt;
        const normalizedRevision = normalizedHostRevision(_session.hostRevision);
        const revisionRepaired = _session.hostRevision !== normalizedRevision;
        _session.hostRevision = normalizedRevision;
        _resumedQueuedHandoff = _session.boundaryHandoff?.queued === true;
        appendTurn({ role: 'event', kind: 'scenario', text: 'Controller restarted — session resumed.' });
        const repaired = refreshHost(contextDate(ctx));
        if (repaired || revisionRepaired || takeoverRepaired || boundaryRepaired) await persist();
        return _session;
      }
      // The restart happened after the station clock crossed the boundary, so
      // the stored outgoing-session key no longer matches. Preserve the
      // boundary record on the fresh incoming session: an armed pair remains
      // eligible to render, while a queued pair is first offered to queue.json
      // recovery and falls back to regeneration if its manifest/audio is gone.
      // An aired pair transfers its programme and covered-intro stamp without
      // reopening the show.
      if (stored?.boundaryHandoff
          && stored.boundaryHandoff.targetKey === sessionKeyFor(ctx)
          && boundaryRunContinues(stored.boundaryHandoff, contextDate(ctx))) {
        const next = start(ctx, buildHandoff(stored as Session));
        const boundary = stored.boundaryHandoff as BoundaryHandoff;
        carryInterruptedProgramme(next, stored.programme, contextDate(ctx));
        if (boundary.programme) next.programme = boundary.programme;
        if (boundary.takeoverStartedAt === undefined) boundary.takeoverStartedAt = next.takeoverStartedAt;
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
        const next = start(ctx);
        carryInterruptedProgramme(next, stored.programme, contextDate(ctx));
        await persist();
        return next;
      }
    } catch {}
  }
  return start(ctx);
}
