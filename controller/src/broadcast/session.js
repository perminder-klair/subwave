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

let _session = null;
let _writeTimer = null;

function mintId() {
  return 'sess_' + randomBytes(4).toString('hex');
}

// Identity of the run. Consecutive hours of the same show share one session;
// an autonomous block rolls when its time period or dominant mood changes.
export function sessionKeyFor(ctx) {
  if (ctx?.activeShow?.id) return `show:${ctx.activeShow.id}`;
  return `auto:${ctx?.time?.period || 'unknown'}:${ctx?.dominantMood || 'none'}`;
}

function scenarioOf(ctx) {
  const w = ctx?.weather?.condition;
  return {
    period: ctx?.time?.period || null,
    vibe: ctx?.time?.vibe || null,
    mood: ctx?.dominantMood || null,
    weather: w && w !== 'unknown' ? w : null,
    festival: ctx?.festival?.name || null,
  };
}

function scenarioText(s) {
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

// One-line summary of a finished session, carried into the next as continuity.
function buildHandoff(prev) {
  if (!prev) return null;
  const plays = prev.messages
    .filter(m => m.kind === 'play')
    .slice(-3)
    .map(m => m.text);
  const lastSpoken = [...prev.messages].reverse()
    .find(m => m.role === 'dj' || m.role === 'segment');
  const parts = [
    prev.kind === 'show'
      ? `the show "${prev.show?.name}"`
      : `a ${prev.scenario.period || ''} block`,
  ];
  if (plays.length) parts.push(`recently aired ${plays.join('; ')}`);
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

async function archive(s) {
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
export function appendTurn({ role, kind, text, meta = {} }) {
  if (!_session) return null;
  const turn = { t: new Date().toISOString(), role, kind, text: text || '', meta };
  _session.messages.push(turn);
  schedulePersist();
  return turn;
}

// Start a fresh session for the current context.
export function start(ctx, handoff = null) {
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

// End + restart if the context no longer matches the live session.
export async function maybeRoll(ctx) {
  if (!_session) return start(ctx);
  const aged = Date.now() - new Date(_session.startedAt).getTime() > MAX_SESSION_MS;
  if (_session.key === sessionKeyFor(ctx) && !aged) return _session;
  const prev = _session;
  await end();
  return start(ctx, buildHandoff(prev));
}

// The bounded chat window fed to the DJ agent — handoff + the last N turns,
// mapped to AI SDK message roles. The full log stays on disk for the UI.
// Consecutive same-role turns are coalesced because some providers (Anthropic)
// require strictly alternating user/assistant messages.
//
// Scenario-kind events (controller restart notes, session boundaries) are
// filtered OUT of the window — they're meta about our infra, not part of the
// DJ's conversation, and they accumulate into user-role noise that derails
// the picker agent (every controller restart leaves "Controller restarted —
// session resumed" stuck in the window, eventually appearing 3-4 times in a
// single coalesced user message).
export function windowMessages() {
  if (!_session) return [];
  const raw = [];
  if (_session.handoff) {
    raw.push({ role: 'user', content: `[Continuing on air from ${_session.handoff}]` });
  }
  for (const m of _session.messages.slice(-WINDOW_TURNS)) {
    if (!m.text) continue;
    if (m.kind === 'scenario') continue;  // infra noise — not for the model
    const role = (m.role === 'dj' || m.role === 'segment') ? 'assistant' : 'user';
    raw.push({ role, content: m.text });
  }
  const out = [];
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
export async function recover(ctx) {
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
