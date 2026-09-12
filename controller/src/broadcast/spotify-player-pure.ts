// Pure parsers for the two Spotify-mode marker files the mixer side writes:
// spotify-player.json (docker/spotify/librespot-event.sh — one librespot event)
// and spotify-audio.json (radio.liq's blank.detect handlers). Every failure
// resolves to null: a marker is a convenience the controller reads on a timer,
// and a torn or absent file must never turn into a decision.

export type SpotifyPlayerEventName =
  | 'track_changed' | 'playing' | 'paused' | 'seeked' | 'position_correction'
  | 'end_of_track' | 'stopped' | 'unavailable' | 'preload_next' | 'preloading' | 'loading'
  | 'session_connected' | 'session_disconnected' | 'session_client_changed'
  | 'volume_changed' | 'shuffle_changed' | 'repeat_changed' | 'auto_play_changed'
  | 'filter_explicit_content_changed' | string;

export interface SpotifyPlayerEvent {
  event: SpotifyPlayerEventName;
  trackId: string | null;
  positionMs: number | null;
  durationMs: number | null;
  // ms epoch when the event script ran — the marker's own clock.
  at: number;
  // Monotonic per-station counter from the event script (absent on a marker
  // written by an older build). The feed reader resumes on it.
  seq: number | null;
}

const ID_RE = /^[0-9A-Za-z]{22}$/;

export function parseSpotifyPlayerEvent(raw: unknown): SpotifyPlayerEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const event = typeof o.event === 'string' ? o.event.trim() : '';
  if (!event || !/^[a-z_]+$/.test(event)) return null;
  const at = Number(o.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const idRaw = typeof o.trackId === 'string' ? o.trackId : '';
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const seq = Number(o.seq);
  return {
    event,
    trackId: ID_RE.test(idRaw) ? idRaw : null,
    positionMs: num(o.positionMs),
    durationMs: num(o.durationMs),
    at,
    seq: Number.isFinite(seq) && seq > 0 ? seq : null,
  };
}

// The append-only feed (spotify-events.jsonl): every parseable line with a
// seq above `afterSeq`, in file order. A torn last line (mid-write) is skipped
// and picked up on the next read.
export function parseSpotifyEventFeed(text: string, afterSeq: number): SpotifyPlayerEvent[] {
  const out: SpotifyPlayerEvent[] = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const ev = parseSpotifyPlayerEvent(parsed);
    if (!ev || ev.seq == null || ev.seq <= afterSeq) continue;
    out.push(ev);
  }
  return out;
}

export interface SpotifyAudioState {
  state: 'silent' | 'audio';
  // seconds epoch (Liquidsoap's time()) → converted to ms here.
  atMs: number;
}

export function parseSpotifyAudioState(raw: unknown): SpotifyAudioState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.state !== 'silent' && o.state !== 'audio') return null;
  const at = Number(o.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  return { state: o.state, atMs: Math.round(at * 1000) };
}
