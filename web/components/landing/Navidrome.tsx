'use client';

import Link from 'next/link';
import EditorialReveal from './EditorialReveal';

const COMPATIBLE = [
  'Navidrome',
  'Subsonic',
  'Airsonic',
  'Gonic',
  'Funkwhale',
  'Nextcloud Music',
  'anything Subsonic-API compatible',
];

export default function Navidrome() {
  return (
    <EditorialReveal className="bs-navidrome bs-section">
      <div className="bs-navidrome-grid">
        <div className="bs-navidrome-copy">
          <p className="bs-eyebrow">WORKS WITH YOUR LIBRARY</p>
          <h2>We don't bring the music. You do.</h2>
          <p className="text-muted">
            SUB/WAVE is the DJ, the mixer, and the broadcast layer. The music
            comes from <strong className="text-ink">your</strong>{' '}
            Navidrome, the self-hosted music server with a Subsonic API. Run
            Navidrome on your homelab, point SUB/WAVE at it, and the DJ
            picks from your collection. Nobody else's algorithm. Nobody else's catalogue.
          </p>

          <ul className="bs-navidrome-bullets">
            <li><strong>Your taste, not a recommendation engine.</strong> The picker reads the metadata you tagged (genres, moods, your own folders) and chooses from there.</li>
            <li><strong>No licensing fees.</strong> You already own (or, you know, have on disk) the music. SUB/WAVE doesn't add a streaming bill on top.</li>
            <li><strong>Private by default.</strong> Listeners hit one MP3 stream. Nobody outside your stack ever sees your library, your tags, or who requested what.</li>
            <li><strong>BYO Subsonic-compatible server.</strong> Subsonic, Airsonic, Gonic, Funkwhale. If it speaks the Subsonic API, it works.</li>
          </ul>

          <div className="bs-navidrome-cta">
            <Link href="/setup" className="bs-tune">
              Connect your library &nbsp;→
            </Link>
            <a
              href="https://www.navidrome.org/"
              target="_blank"
              rel="noreferrer"
              className="bs-link text-[12px] tracking-[0.15em] uppercase"
            >
              New to Navidrome? &nbsp;↗
            </a>
          </div>
        </div>

        <div className="bs-navidrome-diagram" aria-hidden="true">
          {/* Stylized "pipe" diagram: your music → SUB/WAVE → listeners */}
          <div className="bs-pipe-card">
            <div className="bs-pipe-tag">YOUR HOMELAB</div>
            <div className="bs-pipe-row">
              <div className="bs-pipe-icon">♪</div>
              <div className="bs-pipe-meta">
                <div className="bs-pipe-name">Navidrome</div>
                <div className="bs-pipe-sub">navidrome.local:4533</div>
              </div>
              <div className="bs-pipe-status">
                <span className="bs-live-dot" /> CONNECTED
              </div>
            </div>
          </div>

          <div className="bs-pipe-arrow">
            <span>SUBSONIC API</span>
            <div className="bs-pipe-line" />
          </div>

          <div className="bs-pipe-card bs-pipe-card-accent">
            <div className="bs-pipe-tag">SUB/WAVE</div>
            <div className="bs-pipe-row">
              <div className="bs-pipe-icon">⌬</div>
              <div className="bs-pipe-meta">
                <div className="bs-pipe-name">The DJ + the mixer</div>
                <div className="bs-pipe-sub">picks · scripts · broadcasts</div>
              </div>
            </div>
          </div>

          <div className="bs-pipe-arrow">
            <span>ICECAST · ONE STREAM</span>
            <div className="bs-pipe-line" />
          </div>

          <div className="bs-pipe-card">
            <div className="bs-pipe-tag">YOUR LISTENERS</div>
            <div className="bs-pipe-row">
              <div className="bs-pipe-icon">⌇</div>
              <div className="bs-pipe-meta">
                <div className="bs-pipe-name">Anyone with the URL</div>
                <div className="bs-pipe-sub">browser · synced · live</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <p className="bs-navidrome-compat">
        <span className="bs-eyebrow mr-3">ALSO WORKS WITH</span>
        {COMPATIBLE.map((c, i) => (
          <span key={c}>
            <span className="bs-navidrome-pill">{c}</span>
            {i < COMPATIBLE.length - 1 && <span aria-hidden="true" className="mx-[6px] text-muted">·</span>}
          </span>
        ))}
      </p>
    </EditorialReveal>
  );
}
