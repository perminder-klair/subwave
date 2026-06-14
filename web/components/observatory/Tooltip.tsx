/* ============================================================================
   SUB/WAVE — Library Observatory · hover tooltip
   The floating node read-out shown on hover. Shared by the full admin app
   (ObservatoryApp) and the public landing-page showcase (ObservatoryShowcase)
   so both render an identical card. Pure presentational — the parent owns the
   hover state and feeds {track, x, y}.
   ============================================================================ */
'use client';

import type { ObsTrack } from './data';

export interface TipState {
  track: ObsTrack;
  x: number;
  y: number;
}

export default function Tooltip({ data }: { data: TipState | null }) {
  if (!data) return null;
  const { track, x, y } = data;
  const flip = typeof window !== 'undefined' && x > window.innerWidth - 260;
  return (
    <div
      className="obs-tip"
      style={{ left: x + (flip ? -16 : 16), top: y + 16, transform: flip ? 'translateX(-100%)' : 'none' }}
    >
      <div className="tip-genre t-caption ad-muted">
        {(track.genre || 'UNFILED')}
        {track.year ? ` · ${track.year}` : ''}
      </div>
      <div className="tip-title">{track.title || 'Untitled'}</div>
      <div className="tip-artist">{track.artist || 'Unknown'}</div>
      <div className="tip-meta">
        <span>{track.bpm ?? '—'} BPM</span>
        <span className="acc">{track.musicalKey ?? '—'}</span>
        <span>{(track.energy ?? '—').toUpperCase()}</span>
      </div>
      {track.moods.length > 0 && (
        <div className="tip-moods">
          {track.moods.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      )}
    </div>
  );
}
