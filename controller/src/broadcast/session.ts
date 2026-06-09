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

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import * as settings from '../settings.js';
import { logEvent } from '../observability/events.js';

const MAX_SESSION_MS = 4 * 60 * 60 * 1000;  // safety cap — roll even if key is stable
const WINDOW_TURNS = 40;                    // turns fed to the agent (full log is kept)
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
    await writeFile(config.session.currentFile, JSON.stringify(_session, null, 2));
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
    await writeFile(`${config.session.dir}/${s.id}.json`, JSON.stringify(s, null, 2));
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
    messages: [],
  };
  appendTurn({ role: 'event', kind: 'scenario', text: scenarioText(_session) });
  persist();
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
  return start(ctx, buildHandoff(prev));
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
// Three turn kinds get filtered out of the window because they derail the
// picker agent in long sessions:
//
// - `scenario` events (controller restart notes, session boundaries) — infra
//   noise, not part of the DJ's conversation. Every restart leaves "Controller
//   restarted — session resumed" in the window, eventually appearing 3-4
//   times in a single coalesced user message.
//
// - `kind: 'play'` track turns ("▶ Title — Artist") — redundant. Every pick
//   event already contains the current AND previous track ("Now playing X.
//   Pick the next track (after Y)..."), and the picker can't choose recent
//   artists anyway because they're filtered at the tool layer (recentArtists
//   in buildPickerTools).
//
// - OLD `kind: 'pick'` events (role='event') — the "Now playing X. Pick the
//   next track" user-side instruction is kept only for the LATEST pick.
//   Previous ones were already answered and just add ambiguity ("which of
//   these 11 'pick next' requests am I responding to?"). Without this filter,
//   gemini's reliability drops from 5/5 short → 2-3/5 long in the
//   picker-test.mjs LONG benchmark, with "No output generated" failures.
//
// The DJ's own reasons (role='dj' kind='pick') stay — those are the agent's
// short memory of recent decisions, useful for variety.
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
  for (let i = 0; i < recent.length; i++) {
    const m = recent[i];
    if (!m.text) continue;
    if (m.kind === 'scenario') continue;  // infra noise
    if (m.kind === 'play') continue;       // redundant — current track is in the pick event
    if (m.role === 'event' && m.kind === 'pick' && i !== lastPickEventIdx) continue;  // old pick asks
    const role = (m.role === 'dj' || m.role === 'segment') ? 'assistant' : 'user';
    raw.push({ role, content: m.text });
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
