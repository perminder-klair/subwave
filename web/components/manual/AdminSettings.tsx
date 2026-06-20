import Link from 'next/link';
import ManualPage from './ManualPage';

export default function AdminSettings() {
  return (
    <ManualPage
      eyebrow="MANUAL · 07"
      title="Admin & settings."
      intro="For the operator running the station. The admin console is where you shape the DJ, choose the AI providers, schedule shows, and watch how the station is behaving, all without a redeploy."
      current="/manual/admin"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">SIGNING IN</p>
        <h2>The admin console.</h2>
        <p>
          The console lives at <code className="bs-code-inline">/admin</code>. It's gated
          by a single sign-in: the <code className="bs-code-inline">ADMIN_USER</code> and{' '}
          <code className="bs-code-inline">ADMIN_PASS</code> set when the station was
          installed. In production those credentials are mandatory: the station won't
          start without them, because the admin surface reveals too much to leave open.
          Signing in lands you on the Dash.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE LAYOUT</p>
        <h2>Three groups of views.</h2>
        <p>The console's pages are grouped by what they're for:</p>
        <ul className="bs-list">
          <li>
            <strong>Monitor — Dash.</strong> The command centre: what's on air right now,
            with a way to step into the autonomous DJ and steer it directly.
          </li>
          <li>
            <strong>Programming — Library, Shows, Personas, Skills.</strong> Everything
            that shapes what the station plays and who it sounds like.
          </li>
          <li>
            <strong>System — Stats, Settings, Debug.</strong> How the station is behaving
            under the hood, the engine-room settings, and a live diagnostic view.
          </li>
        </ul>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">PROGRAMMING</p>
        <h2>Shaping the station.</h2>
        <p>
          Everything in this group is saved durably and applies live. No redeploy, and most
          changes land on the next thing the DJ does.
        </p>
        <ul className="bs-list">
          <li>
            <strong>Library</strong> — search the music library and check how well it's
            been mood-tagged. The tagger labels tracks with a mood so the DJ can pick by
            feel; this is where you watch its progress.
          </li>
          <li>
            <strong>Shows</strong> — a show is a reusable definition: a name, a topic, a
            persona, a mood. Paint shows onto a weekly grid hour by hour; an empty hour
            means the station runs autonomously for that hour.
          </li>
          <li>
            <strong>Personas</strong> — the roster of DJ identities, one to ten. Each has
            a name and character, a voice, a script length and a talk frequency, plus the
            skills it's allowed to use. One persona is active at a time (though a
            scheduled show can override which), and a single prompt template is shared by
            all of them.
          </li>
          <li>
            <strong>Skills</strong> — the real-world segments the autonomous DJ can run:
            weather, news, traffic, facts, web search. Toggle each on or off
            station-wide.
          </li>
        </ul>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">SETTINGS</p>
        <h2>The engine room.</h2>
        <p>
          The Settings page collects the lower-level controls, in five panels:
        </p>
        <ul className="bs-list">
          <li>
            <strong>TTS voice</strong> — which text-to-speech engine and voice the DJ
            speaks with, optionally a different one per kind of segment. The engines
            (local and cloud) are covered in{' '}
            <Link href="/manual/dj" className="bs-link">How the DJ Works</Link>.
          </li>
          <li>
            <strong>LLM provider</strong> — which model writes the DJ's words and picks
            tracks, plus the toggles that tune the station to that model. See{' '}
            <Link href="/manual/llm" className="bs-link">Models &amp; Tokens</Link>.
          </li>
          <li>
            <strong>Mixer</strong> — crossfade length, how often a jingle plays between
            tracks, and the station's weather location.
          </li>
          <li>
            <strong>Jingles</strong> — the short pre-rendered idents the station rotates
            between music tracks. Render them through the configured voice, or import your
            own mp3/wav; new files are picked up automatically.
          </li>
          <li>
            <strong>Sound FX</strong> — the library of stingers the DJ can drop into a
            spoken break. Generate one from a text prompt, or import your own audio file
            (no ElevenLabs key needed). Toggle the whole library on or off.
          </li>
        </ul>
        <div className="bs-callout">
          <div className="bs-eyebrow">MIX CHANGES NEED A MIXER RESTART</div>
          <p>
            Crossfade and jingle-ratio changes are read by the audio mixer only at
            startup. The settings page can trigger that restart for you: the stream drops
            for a few seconds and comes back with the new values applied.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WHEN SOMETHING'S OFF</p>
        <h2>Stats &amp; debug.</h2>
        <p>
          <strong>Stats</strong> reports how the station is performing: AI usage and
          latency, and how often it's had to fall back to a backup engine.{' '}
          <strong>Debug</strong> is a live snapshot for diagnosing trouble: recent AI
          calls, the mixer's status, and the most recent log lines. It's the first place
          to look if the stream stalls or the DJ goes quiet.
        </p>
        <p>
          Installing or updating the station rather than tuning it? That's covered in{' '}
          <Link href="/setup" className="bs-link">the setup guide</Link>.
        </p>
      </section>
    </ManualPage>
  );
}
