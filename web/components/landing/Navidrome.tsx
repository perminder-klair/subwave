'use client';

import Link from 'next/link';
import { AnimatedLink } from '@/components/ui/animated-link';
import EditorialReveal from './EditorialReveal';

const COMPATIBLE = [
  'Navidrome',
  'Jellyfin',
  'Plex',
  'Subsonic',
  'Airsonic',
  'Gonic',
  'Funkwhale',
  'a folder of files',
  'anything with a source plugin',
];

export default function Navidrome() {
  return (
    <EditorialReveal className="bs-navidrome bs-section bs-section--tight">
      <div className="bs-navidrome-grid">
        <div className="bs-navidrome-copy">
          <p className="bs-eyebrow">WORKS WITH YOUR LIBRARY</p>
          <h2>We don&rsquo;t bring the music. You do.</h2>
          <p className="text-muted">
            SUB/WAVE is the DJ, the mixer, and the broadcast layer. The music
            comes from <strong className="text-ink">your</strong>{' '}
            library: Navidrome, Jellyfin or Plex on your homelab, or anything
            a source plugin can read. Point SUB/WAVE at it, and the DJ
            picks from your collection. Nobody else&rsquo;s algorithm. Nobody else&rsquo;s catalogue.
          </p>

          <ul className="bs-navidrome-bullets">
            <li><strong>Your taste, not a recommendation engine.</strong> The picker reads the metadata you tagged (genres, moods, your own folders) and chooses from there.</li>
            <li><strong>No licensing fees.</strong> You already own (or, you know, have on disk) the music. SUB/WAVE doesn&rsquo;t add a streaming bill on top.</li>
            <li><strong>Private by default.</strong> Listeners hit one MP3 stream. Nobody outside your stack ever sees your library, your tags, or who requested what.</li>
            <li><strong>The server you already run.</strong> Navidrome, Jellyfin and Plex are built in, and any Subsonic-compatible server works. Something else? A source plugin is one small file.</li>
            <li><strong>Switch without starting over.</strong> Move from one server to another and your mood tags, analysis and likes follow the music.</li>
            <li><strong>Scrobbles like a real station.</strong> Every spin can report to Last.fm or ListenBrainz, including your own self-hosted instance.</li>
          </ul>

          <div className="bs-navidrome-cta">
            <Link href="/setup" className="bs-tune">
              Connect your library <span aria-hidden="true">&nbsp;→</span>
            </Link>
            <AnimatedLink
              href="/manual/music-sources"
              variant="arrow"
              className="text-[12px] font-semibold tracking-[0.15em] text-ink uppercase hover:text-vermilion"
            >
              Supported libraries
            </AnimatedLink>
          </div>
        </div>

        <div className="bs-navidrome-diagram" aria-hidden="true">
          <div className="bs-pipe-card">
            <div className="bs-pipe-tag">YOUR HOMELAB</div>
            <div className="bs-pipe-row">
              <div className="bs-pipe-icon">♪</div>
              <div className="bs-pipe-meta">
                <div className="bs-pipe-name">Your music server</div>
                <div className="bs-pipe-sub">navidrome · jellyfin · plex</div>
              </div>
              <div className="bs-pipe-status">
                <span className="bs-live-dot" /> CONNECTED
              </div>
            </div>
          </div>

          <div className="bs-pipe-arrow">
            <span>SUBSONIC API · SOURCE PLUGINS</span>
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
