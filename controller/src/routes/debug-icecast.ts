// Pure projection of Icecast status-json for the admin Debug card.
// Keep the normalized sources for the per-mount table in the same snapshot.
export type IcecastSource = Record<string, unknown>;

export interface IcecastStats {
  source?: IcecastSource | IcecastSource[] | null;
  server_start_iso8601?: string;
}

export function icecastDebugSnapshot(ic: IcecastStats) {
  const sources = Array.isArray(ic.source) ? ic.source : ic.source ? [ic.source] : [];
  // Metadata follows MP3, with a first-source fallback when it is absent.
  // Encoder connection order must not decide the advertised bitrate/title.
  const primary = sources.find(s => String(s?.listenurl || '').includes('/stream.mp3'))
    ?? sources[0];
  // Raw sockets across ALL connected mounts, deliberately separate from the
  // deduped/gated listener monitor. This card diagnoses what Icecast reports.
  const listeners = sources.reduce((sum, s) => sum + Number(s?.listeners || 0), 0);
  // Independent per-mount high-water marks, possibly reached at different
  // times. This sum is not a measured simultaneous station peak.
  const listener_peak = sources.reduce((sum, s) => sum + Number(s?.listener_peak || 0), 0);
  const activeMounts = sources.map(s => String(s?.listenurl || '')).filter(Boolean);

  const status = primary ? {
    title: primary.title,
    bitrate: primary.bitrate,
    listeners,
    listener_peak,
    activeMounts,
    stream_start: primary.stream_start_iso8601,
    server_start: ic.server_start_iso8601,
  } : { error: 'no source connected' };

  return { sources, status };
}
