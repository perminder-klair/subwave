// Display helpers for live-session turns served by GET /session.
// Ported from web/lib/sessionFeed.js — a session turn is { t, role, kind,
// text, meta }.
//
// role → display class:
//   voice  — spoken on-air verbatim (links, station IDs, time, weather)
//   dj     — the DJ agent's pick / request reasoning (the "thinking")
//   track  — a track that aired
//   system — system events (session start, pick prompts, restarts)

export function turnClass(turn) {
  switch (turn?.role) {
    case 'segment': return 'voice';
    case 'dj':      return 'dj';
    case 'track':   return 'track';
    default:        return 'system';
  }
}

export const isVoice = (turn) => turnClass(turn) === 'voice';

// "DJ" view = everything the DJ personally said or decided.
export const isDjTurn = (turn) => {
  const c = turnClass(turn);
  return c === 'voice' || c === 'dj';
};

// Plain display text. `track` turns already carry a "▶ …" prefix in their
// text; strip it so callers can supply their own marker.
export function turnText(turn) {
  const text = turn?.text || '';
  if (turnClass(turn) === 'track') return text.replace(/^▶\s*/, '');
  return text;
}
