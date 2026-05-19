import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useAnimation } from 'ink';
import { c } from '../theme.js';

// Classic Winamp-style spectrum analyzer for the terminal.
//
//   ▄ ▄   ▄
//   █ █ ▄ █ ▄
//   █ █ █ █ █  ← stacked block bars per band
//   █ █ █ █ █
//   ▔ ▔ ▔ ▔ ▔  ← peak-hold dots (a different glyph row from the bars)
//
// We have no real PCM (the audio is rendered by an out-of-process mpv /
// ffplay), so the values are a pseudo-musical random walk: each band
// drifts toward a fresh random target, and a peak indicator falls slowly
// from each band's most-recent high. The top of the column is red, the
// middle yellow, the lower three rows green — same colour ramp as the
// Winamp 2.x AVS skin.
//
// Driven by Ink's `useAnimation` (shared timer, so multiple animated
// widgets don't fight for render slots) at ~80 ms, paired with
// `incrementalRendering` on the root `render()` to keep flicker down.
const COLORS_TOP_DOWN = [c.danger, c.danger, c.warn, c.warn, c.lcd, c.lcd, c.lcd, c.lcdDim];

export default function Spectrum({ width = 48, height = 8, active = true, seed = '' }) {
  const w = Math.max(8, Math.floor(width));
  const h = Math.max(3, Math.floor(height));

  // Bar / peak state lives in refs so the animation step can mutate cheaply;
  // we still bump a frame counter so React re-renders.
  const bars  = useRef(new Float32Array(w));
  const peaks = useRef(new Float32Array(w));
  const targets = useRef(new Float32Array(w));
  const [, setFrame] = useState(0);

  // Reset arrays when width or seed (track) changes.
  useEffect(() => {
    bars.current  = new Float32Array(w);
    peaks.current = new Float32Array(w);
    targets.current = new Float32Array(w);
    setFrame(f => f + 1);
  }, [w, seed]);

  const { frame } = useAnimation({ interval: 80, isActive: active });

  // Step the simulation once per animation frame. We do this inline (not in
  // an effect) so the new values are visible in this render — and use a
  // ref so we only step when `frame` changed.
  const lastFrame = useRef(-1);
  if (frame !== lastFrame.current) {
    lastFrame.current = frame;
    step(bars.current, peaks.current, targets.current, w);
  }

  // Build each row as a single string per colour — fewer text spans = less
  // work for Ink's diff + log-update.
  const rows = [];
  for (let r = 0; r < h; r++) {
    // Row 0 is the top of the column; threshold is the fractional height
    // a column must reach to light this row.
    const threshold = (h - r) / h;
    const nextThreshold = (h - r - 1) / h;
    let line = '';
    for (let col = 0; col < w; col++) {
      const v = bars.current[col];
      const p = peaks.current[col];
      // Peak marker first — wins over the bar so the dot sits on top.
      if (p > 0 && p >= nextThreshold && p < threshold + 1 / h && p < threshold) {
        line += '▔';
      } else if (v >= threshold) {
        line += '█';
      } else if (v >= threshold - 0.5 / h) {
        // Top-of-bar partial cell for a subtler ramp.
        line += '▄';
      } else {
        line += ' ';
      }
      line += ' '; // one-space gutter between bands → wider Winamp look
    }
    const color = COLORS_TOP_DOWN[Math.min(COLORS_TOP_DOWN.length - 1, r)];
    rows.push(<Text key={r} color={color}>{line}</Text>);
  }
  return <Box flexDirection="column">{rows}</Box>;
}

// One step of the random walk.
function step(bars, peaks, targets, w) {
  for (let i = 0; i < w; i++) {
    // Re-pick a target ~10% of frames so each band drifts visibly.
    if (Math.random() < 0.12 || targets[i] === 0) {
      // Centre-weighted shape — Winamp's spectrums tend to bulge in the
      // mids and taper toward the rails.
      const centre = 1 - Math.abs(i / (w - 1) - 0.5) * 1.4;
      targets[i] = Math.max(0.05, Math.min(1, Math.random() * Math.max(0.15, centre) * 1.1));
    }
    // Ease toward target.
    bars[i] = bars[i] * 0.62 + targets[i] * 0.38;
    // Peak hold: rises instantly to bar, falls slowly.
    if (bars[i] > peaks[i]) peaks[i] = bars[i];
    else peaks[i] = Math.max(0, peaks[i] - 0.018);
  }
}
