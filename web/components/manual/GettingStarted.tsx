import Link from 'next/link';
import ManualPage from './ManualPage';

export default function GettingStarted() {
  return (
    <ManualPage
      eyebrow="MANUAL · 01"
      title="Tuning in."
      intro="Everything a listener needs: how to start the stream, what the player shows you, and why it behaves a little differently from the music apps you're used to."
      current="/manual/getting-started"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">PRESS PLAY</p>
        <h2>Open the player and you're on the air.</h2>
        <p>
          The station lives at the home page, and always at{' '}
          <Link href="/listen" className="bs-link">/listen</Link>. Open it and press play.
          The stream connects and you hear the broadcast already in progress. There's
          nothing to pick first; the DJ is already mid-show.
        </p>
        <p>
          Because it's a live stream, pressing pause and playing again doesn't resume
          where you left off. It drops you back into the broadcast as it is now, the same
          as everyone else listening.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE PLAYER</p>
        <h2>What you're looking at.</h2>
        <p>
          The player shows the track that's playing right now (title, artist, and cover
          art) with a waveform for the transport. Three panels slide out for the rest:
        </p>
        <ul className="bs-list">
          <li>
            <strong>Make a request</strong> — ask the DJ for a song, an artist, or a mood.
            See <Link href="/manual/requests" className="bs-link">Making Requests</Link>.
          </li>
          <li>
            <strong>Timeline</strong> — what's played recently and what's queued up next.
          </li>
          <li>
            <strong>The booth</strong> — a running feed of what the DJ has been saying:
            intros, station IDs, the time, weather.
          </li>
        </ul>
        <p className="text-muted">
          Now-playing info refreshes every few seconds, so the player stays in step with
          the broadcast without you doing anything.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">NO SKIP — ON PURPOSE</p>
        <h2>There is no skip button.</h2>
        <p>
          A track ends when it ends. SUB/WAVE has no <code className="bs-code-inline">/skip</code>:
          the only natural transition is track-end, and the mixer controls pacing. Skip is
          deliberately left off the lock-screen and headphone controls too, so a stray
          double-tap on your earbuds can't cut the song short for every other listener.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">INSTALL IT</p>
        <h2>Add SUB/WAVE to your phone.</h2>
        <p>
          SUB/WAVE is an installable web app. Use your browser's &ldquo;Add to Home
          Screen&rdquo; / &ldquo;Install&rdquo; option and it runs like a native app, with
          its own icon. Once installed, your phone's lock screen, headphone buttons, and
          car display can all start and stop the stream, with the cover art of whatever
          is currently on the air.
        </p>
      </section>
    </ManualPage>
  );
}
