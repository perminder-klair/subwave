import PlayerShowcase from '../landing/PlayerShowcase';
import EditorialReveal from '../landing/EditorialReveal';
import type { ShowcaseStation } from '@/lib/stations';

const POINTS = [
  {
    eyebrow: 'NOW PLAYING',
    title: 'The track, the artist, the booth.',
    body:
      'The player opens on whatever is on air: cover art pulled straight from your library, title, artist, album, and elapsed time. A waveform tracks the audio underneath. It is not your queue. It is the station’s.',
  },
  {
    eyebrow: 'TIMELINE & BOOTH',
    title: 'See what is coming, hear what was said.',
    body:
      'Two drawers slide out from the side. The Timeline shows tracks queued and recently played; the Booth is a live log of every word the DJ has spoken: station IDs, time checks, weather, the links between songs.',
  },
  {
    eyebrow: 'NO SKIP, ON PURPOSE',
    title: 'A shared broadcast, not a remote control.',
    body:
      'There is no skip control for listeners. A stray double-tap on someone’s headphones should not change the song for everyone else. Track-end is the only natural transition. Radio behaves like radio.',
  },
  {
    eyebrow: 'INSTALL IT',
    title: 'A real app on the lock screen.',
    body:
      'Native iOS and Android apps are on the stores, and the web player installs as a PWA. The OS media controls wire straight through, so the lock screen, your headphones, and the car display all show the station. Old-school hardware? /listen.m3u and /listen.pls tune in VLC, Sonos, and internet radios.',
  },
];

export default function OnTheAir({ stations = [] }: { stations?: ShowcaseStation[] }) {
  return (
    <EditorialReveal className="bs-section border-t-0">
      <p className="bs-eyebrow">PART ONE · THE PLAYER</p>
      <h2>One stream, every listener.</h2>
      <p className="text-muted">
        Open the player and you join a broadcast already in progress. Here is
        what a listener actually sees.
      </p>

      <PlayerShowcase stations={stations} />

      <div className="bs-whatis-grid mt-4">
        {POINTS.map((p) => (
          <article key={p.eyebrow} className="bs-whatis-card">
            <div className="bs-eyebrow mb-2">{p.eyebrow}</div>
            <h3 className="m-0 mb-[10px] text-[clamp(20px,2.2vw,26px)] leading-[1.15] font-extrabold tracking-[-0.02em]">
              {p.title}
            </h3>
            <p className="m-0 text-[14px] leading-[1.55] text-muted">
              {p.body}
            </p>
          </article>
        ))}
      </div>
    </EditorialReveal>
  );
}
