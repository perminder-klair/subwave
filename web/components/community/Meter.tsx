import s from './community.module.css';

// A ten-segment LED meter for a 0–10 tone dial. An absent dial is "neutral",
// drawn as an unlit ladder with the word beside it, never as a zero.
export function LedMeter({ label, value }: { label: string; value?: number }) {
  const known = typeof value === 'number' && Number.isFinite(value);
  const v = known ? Math.max(0, Math.min(10, Math.round(value))) : 0;
  return (
    <div className={s.meterRow}>
      <dt className={s.meterLabel}>{label}</dt>
      <dd className={s.meterValue}>
        <span className={s.led} aria-hidden="true" data-neutral={known ? undefined : ''}>
          {Array.from({ length: 10 }, (_, i) => (
            <span key={i} className={s.ledSeg} data-on={i < v ? '' : undefined} data-hot={i >= 7 ? '' : undefined} />
          ))}
        </span>
        <span className={s.meterNum}>{known ? `${v}/10` : 'neutral'}</span>
      </dd>
    </div>
  );
}

// Phone-style signal bars: `level` of `max` lit.
// Four bars, stepped 25/50/75/100% tall in CSS.
export function SignalBars({ level, max = 4 }: { level: number; max?: number }) {
  return (
    <span className={s.signal} aria-hidden="true">
      {Array.from({ length: max }, (_, i) => (
        <span
          key={i}
          className={s.signalBar}
          data-on={i < level ? '' : undefined}
        />
      ))}
    </span>
  );
}

// A barcode seeded from a string: purely decorative, a ticket-stub flourish.
export function Barcode({ seed, className }: { seed: string; className?: string }) {
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  let h = 0x9e3779b9;
  for (let i = 0; i < seed.length * 4 && x < 116; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i % seed.length), 0x01000193) >>> 0;
    const w = 1 + (h % 3);
    const gap = 1 + ((h >>> 3) % 3);
    bars.push({ x, w });
    x += w + gap;
  }
  return (
    <svg viewBox="0 0 120 28" className={className} aria-hidden="true" focusable="false" preserveAspectRatio="none">
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y="0" width={b.w} height="28" fill="currentColor" />
      ))}
    </svg>
  );
}
