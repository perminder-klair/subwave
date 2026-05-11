'use client';

import Link from 'next/link';

export default function StationFooter({ djName }) {
  return (
    <footer style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="bs-rule-double" />
      <div
        className="flex flex-wrap items-baseline justify-between"
        style={{ padding: '20px 0', gap: 16, fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)' }}
      >
        <span style={{ color: 'var(--ink)', fontWeight: 700 }}>SUB/WAVE · EST. 2026</span>
        <span>
          Navidrome · Liquidsoap · Icecast · Ollama · Piper
        </span>
        <span>
          {djName ? `${djName} on the desk · ` : ''}
          <a
            href="https://github.com/pklair/subwave"
            target="_blank"
            rel="noreferrer"
            className="bs-link"
            style={{ letterSpacing: 'inherit' }}
          >
            GitHub →
          </a>
        </span>
      </div>
      <div
        style={{
          fontSize: 10,
          letterSpacing: '0.3em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
          textAlign: 'center',
          paddingBottom: 6,
        }}
      >
        — End of broadcast page · <Link href="/listen" className="bs-link" style={{ letterSpacing: 'inherit' }}>open the player</Link> —
      </div>
    </footer>
  );
}
