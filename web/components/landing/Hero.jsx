'use client';

import PlayerShowcase from './PlayerShowcase';

export default function Hero({ djName }) {
  return (
    <section className="bs-hero">
      <div className="bs-hero-head">
        <p className="bs-eyebrow">A REAL INTERNET RADIO STATION</p>
        <h1 className="bs-hero-title">
          One stream.<br />
          One station.<br />
          Every listener at the same time.
        </h1>
        <p className="bs-hero-deck">
          SUB/WAVE is a personal radio frequency broadcasting from a homelab.
          {djName ? ` ${djName} ` : ' An LLM-driven DJ '}
          picks every track, reads the weather, and announces what's next over
          the bed. You don't pick the songs. You tune in.
        </p>
      </div>

      <PlayerShowcase />

      <p className="bs-hero-foot">
        Hit <strong style={{ color: 'var(--ink)' }}>▶ TUNE IN</strong> in the
        player above. That's not a screenshot — that's the actual station, on air right now.
      </p>
    </section>
  );
}
