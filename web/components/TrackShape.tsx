'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { pollWhileVisible } from '@/lib/poll';
import type { TrackAnalysis } from '@/lib/types';

// SVG user space for the pace curve (preserveAspectRatio: none, so it stretches
// to the band width). Mirrors the "Track shape" design concept.
const W = 1000;
const H = 100;
const PAD = 8;

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export interface TrackShapeProps {
  analysis: TrackAnalysis;
  tunedIn: boolean;
  /** Epoch ms when the current track started (from useStationFeed). */
  trackStartedAt: number | null;
  /** Track length in seconds (0/undefined falls back to the analysis window). */
  duration: number;
}

/** True when there's enough acoustic data to draw the band (a curve or
 *  sections). bpm/key/LUFS alone don't make a band — the caller falls back to
 *  the plain waveform in that case. */
export function hasTrackShape(a?: TrackAnalysis | null): boolean {
  return !!(a && ((a.pace && a.pace.length) || (a.structure && a.structure.length)));
}

const yOf = (v: number) => H - PAD - v * (H - PAD * 2);

// Build the pace polyline + filled-area path from the analysis spans. Each
// span contributes a point at its midpoint; the curve is anchored to the
// baseline at both ends so the area fill closes cleanly.
function buildCurve(
  pace: TrackAnalysis['pace'],
  durMs: number,
): { line: string; area: string } {
  if (!pace || !pace.length) return { line: '', area: '' };
  const pts = pace.map((p) => {
    const x = ((p.startMs + p.endMs) / 2 / durMs) * W;
    return { x: Math.max(0, Math.min(W, x)), y: yOf(Math.max(0, Math.min(1, p.value))) };
  });
  // clamp endpoints to the band edges
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const seq = [{ x: 0, y: first.y }, ...pts, { x: W, y: last.y }];
  const line = seq.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const area = `M0 ${H} ${seq.map((p) => `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')} L${W} ${H} Z`;
  return { line, area };
}

function sectionIndexAt(structure: TrackAnalysis['structure'], tMs: number): number {
  if (!structure || !structure.length) return -1;
  const i = structure.findIndex((s) => tMs >= s.startMs && tMs < s.endMs);
  return i >= 0 ? i : structure.length - 1;
}

function keyAt(analysis: TrackAnalysis, tMs: number): string | null {
  const ranges = analysis.keyRanges;
  if (ranges && ranges.length) {
    const r = ranges.find((x) => tMs >= x.startMs && tMs < x.endMs) ?? ranges[0];
    if (r?.key) return r.key;
  }
  return analysis.key;
}

export default memo(function TrackShape({ analysis, tunedIn, trackStartedAt, duration }: TrackShapeProps) {
  // Analysis-window length: the largest endMs across all spans, falling back to
  // the track duration. Everything (spans + playhead) positions against this
  // single scale so the structure labels and the needle stay aligned.
  const durMs = useMemo(() => {
    let m = duration > 0 ? duration * 1000 : 0;
    for (const s of analysis.structure ?? []) m = Math.max(m, s.endMs);
    for (const p of analysis.pace ?? []) m = Math.max(m, p.endMs);
    for (const v of analysis.vocals ?? []) m = Math.max(m, v.endMs);
    return m || 1;
  }, [analysis, duration]);
  const durSec = durMs / 1000;

  const { line, area } = useMemo(() => buildCurve(analysis.pace, durMs), [analysis.pace, durMs]);

  // Sparse state tick (~2 Hz) for the discrete bits: which section glows, the
  // live key, the clock text. The continuously-moving visuals (playhead + fill
  // clip) run on rAF below with zero React renders.
  const [tMs, setTMs] = useState(0);
  useEffect(() => {
    if (!tunedIn || trackStartedAt == null) {
      setTMs(0);
      return;
    }
    return pollWhileVisible(() => {
      setTMs(Math.min(durMs, Date.now() - trackStartedAt));
    }, 500);
  }, [tunedIn, trackStartedAt, durMs]);

  // Smooth playhead + area-fill clip, driven imperatively so the band animates
  // at frame rate without re-rendering the SVG (the Waveform pattern).
  const phRef = useRef<HTMLSpanElement>(null);
  const clipRef = useRef<SVGRectElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const park = () => {
      if (phRef.current) phRef.current.style.left = '0%';
      if (clipRef.current) clipRef.current.setAttribute('width', '0');
    };
    if (!tunedIn || trackStartedAt == null) {
      park();
      return;
    }
    let raf = 0;
    const tick = () => {
      const sec = (Date.now() - trackStartedAt) / 1000;
      const p = Math.min(1, Math.max(0, sec / durSec));
      if (phRef.current) phRef.current.style.left = `${(p * 100).toFixed(2)}%`;
      if (clipRef.current) clipRef.current.setAttribute('width', (p * W).toFixed(1));
      if (timeRef.current?.firstChild) timeRef.current.firstChild.textContent = `${fmt(Math.min(durSec, sec))} `;
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [tunedIn, trackStartedAt, durSec]);

  const curIdx = sectionIndexAt(analysis.structure, tMs);
  const keyLabel = keyAt(analysis, tMs);
  const meta = [
    analysis.bpm != null ? `${Math.round(analysis.bpm)} BPM` : null,
    keyLabel,
    analysis.loudnessLufs != null ? `${analysis.loudnessLufs} LUFS` : null,
  ].filter(Boolean).join('  ·  ');

  return (
    <div
      className="tr-band pointer-events-none absolute inset-x-3 bottom-24 flex h-[118px] flex-col font-mono sm:right-24 sm:bottom-[128px] sm:left-0 sm:h-[150px]"
      aria-hidden="true"
    >
      <div className="tr-head">
        <span>Track shape</span>
        <span className="tr-head-meta">{meta}</span>
      </div>
      <div className="tr-shape">
        <svg className="tr-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <clipPath id="tr-ph-clip">
              <rect ref={clipRef} x="0" y="0" width="0" height={H} />
            </clipPath>
          </defs>
          {area && <path d={area} className="tr-area-faint" />}
          {area && <path d={area} className="tr-area" clipPath="url(#tr-ph-clip)" />}
          {line && <path d={line} className="tr-line" />}
        </svg>

        {/* structure dividers + small-caps labels (current glows) */}
        {(analysis.structure ?? []).map((s, i) => (
          <span key={`d${i}`}>
            {i > 0 && (
              <span
                className="tr-div"
                ref={(el) => { if (el) el.style.setProperty('left', `${(s.startMs / durMs) * 100}%`); }}
              />
            )}
            {s.kind && (
              <span
                className="tr-seclbl"
                data-on={i === curIdx ? 'true' : undefined}
                ref={(el) => { if (el) el.style.setProperty('left', `${((s.startMs + s.endMs) / 2 / durMs) * 100}%`); }}
              >
                {s.kind}
              </span>
            )}
          </span>
        ))}

        {/* vocal-presence lane */}
        {analysis.vocals && analysis.vocals.length > 0 && (
          <div className="tr-vlane">
            <span className="tr-vlbl">VOX</span>
            {analysis.vocals.map((v, i) => (
              <span
                key={`v${i}`}
                className="tr-vseg"
                data-on={tMs >= v.startMs && tMs < v.endMs ? 'true' : undefined}
                ref={(el) => {
                  if (!el) return;
                  el.style.setProperty('left', `${(v.startMs / durMs) * 100}%`);
                  el.style.setProperty('width', `${((v.endMs - v.startMs) / durMs) * 100}%`);
                }}
              />
            ))}
          </div>
        )}

        <span className="tr-ph" ref={phRef} />
        <span className="tr-time" ref={timeRef}>
          {fmt(0)} <span> / {fmt(durSec)}</span>
        </span>
      </div>
    </div>
  );
});
