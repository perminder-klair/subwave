import Link from 'next/link';
import ManualPage from './ManualPage';
import ManualFigure from './ManualFigure';

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
            <strong>Programming — Library, Shows, Personas, Skills, Imaging, Moods.</strong>{' '}
            Everything that shapes what the station plays and who it sounds like.
          </li>
          <li>
            <strong>System — Stats, Connect, Stations, Settings, Debug.</strong> How the
            station is behaving under the hood, the ways to plug other tools into it,
            which of this install's stations is on air, the engine-room settings, and a
            live diagnostic view.
          </li>
        </ul>
        <ManualFigure
          src="/screenshots/admin-dash.webp"
          alt="The admin Dash: the track on air with a skip button, gauges for listeners, DJ latency and TTS fallback, the queue and booth log on the left, and manual voice, segment fire pads and broadcast switches on the right"
          caption="The Dash. The track on air and its gauges across the top, the queue and the booth log down the left, and on the right the controls that let you speak through the DJ or fire a segment on demand."
          width={2732}
          height={2048}
        />
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
            feel; this is where you watch its progress. Two doorways open from here: the{' '}
            <strong>Playlist Builder</strong>, where you generate a set from a vibe prompt
            and tuning, then save it for the DJ and shows to draw on, and the{' '}
            <Link href="/manual/observatory" className="bs-link">Library Observatory</Link>,
            a visual map of everything the station has heard. The <strong>Blocked</strong>{' '}
            tab is the never-play list: block one exact track, album or artist from any
            row, or write a <strong>blocking rule</strong> — everything carrying a tag or
            genre, everything in a playlist — optionally with a seasonal window (Christmas
            songs only air Dec 1–26) or scoped to certain shows. Rules match any tag the
            station ingests (genre tags, moods, audio moods, Last.fm tags); a custom label
            like a country works as soon as you write it into the genre or mood field of
            your files. Both kinds are absolute: refused everywhere, requests included.
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
            weather, news, now-playing digs, facts, web search. Toggle each on or off
            station-wide.
          </li>
          <li>
            <strong>Imaging</strong> — the sounds the DJ drops between and over the music.
            Three tabs: <strong>Jingles</strong> (the short station idents rotated between
            tracks, plus how often one plays), <strong>SFX</strong> (stingers mixed under
            the DJ's voice mid-break), and <strong>Beds</strong> (instrumentals the DJ
            talks over when a link runs long). Render each through the configured voice or
            a text-to-sound prompt, or import your own audio; new files are picked up
            automatically.
          </li>
          <li>
            <strong>Moods</strong> — the station's mood vocabulary and how the autonomous
            DJ reaches for it. Four tabs: <strong>Vocabulary</strong> (the moods every
            track is tagged with, each with an optional sound description for audio
            tagging), <strong>Moments</strong> (which mood each part of the day and each
            weather condition leans into), <strong>Festivals</strong> (the calendar that
            nudges the mood on the day), and <strong>Speech</strong> (pronunciation fixes
            applied to every spoken line). Edit the vocabulary and every show, festival,
            and auto-DJ pick draws from it.
          </li>
        </ul>
        <div className="bs-manual-figrow">
          <ManualFigure
            src="/screenshots/admin-library.webp"
            alt="The admin Library page: a headline reading how much of the library the DJ knows, a mood-and-energy tagging progress bar, an acoustic-analysis coverage line, and a list of recently added tracks with their mood tags"
            caption="Library — how much of the collection is tagged, what the analyzer has measured, and the recently-added tracks still waiting."
            width={2732}
            height={2048}
          />
          <ManualFigure
            src="/screenshots/admin-schedule.webp"
            alt="The admin Schedule page: on air, up next and after that across the top, a sentence-style form for booking a show, a shelf of saved shows, and a seven-column grid of coloured show blocks by hour"
            caption="Schedule — the week as a grid you paint. On air, up next and after that ride along the top; empty hours run autonomously."
            width={2732}
            height={2048}
          />
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">SETTINGS</p>
        <h2>The engine room.</h2>
        <p>
          The Settings page collects the lower-level controls as a stack of panels down
          the left rail. The ones you'll reach for most:
        </p>
        <ul className="bs-list">
          <li>
            <strong>Station</strong> — the name, locale, timezone, and the weather
            location the DJ reads from.
          </li>
          <li>
            <strong>Music Selection</strong> — choose how tracks are selected (Agentic
            Tools or Track Shortlist), and independently whether listener requests use
            direct matching or agent assistance. It sits just below Music Source.
          </li>
          <li>
            <strong>DJ Behaviour</strong> — configure segments and skills, then the
            station&rsquo;s show and talk behaviour.
          </li>
          <li>
            <strong>LLM provider</strong> — where the model runs and which model writes
            the DJ's words. See{' '}
            <Link href="/manual/llm" className="bs-link">Models &amp; Tokens</Link>.
          </li>
          <li>
            <strong>TTS voice</strong> — which text-to-speech engine and voice the DJ
            speaks with, optionally a different one per kind of segment. The engines
            (local and cloud) are covered in{' '}
            <Link href="/manual/dj" className="bs-link">How the DJ Works</Link>.
          </li>
          <li>
            <strong>Library tagger</strong> — the embedding provider and mood-propagation
            settings behind the mood tags, plus where you kick off a tagging run.
          </li>
          <li>
            <strong>Web search</strong> — the live-facts backend the skills draw on
            (DuckDuckGo, Tavily, or a self-hosted SearXNG).
          </li>
          <li>
            <strong>Skin &amp; themes</strong> — the player's default face (skin) and the
            station-wide colour palette. Covered in{' '}
            <Link href="/manual/themes" className="bs-link">Skins &amp; Themes</Link>.
          </li>
          <li>
            <strong>Likes</strong> — the listener heart button: whether it shows, whether a
            like stars the track in Navidrome, and whether recent likes nudge what the DJ
            plays.
          </li>
          <li>
            <strong>Scrobbling, Archives &amp; Backup</strong> — scrobble plays to Last.fm
            / ListenBrainz, record the broadcast to hourly files, and export or restore the
            whole station's config.
          </li>
          <li>
            <strong>Danger zone</strong> — the broadcast controls that bite: crossfade
            length, max track length, loudness levelling, the optional Opus / FLAC / AAC
            stream mounts, and the buttons that stop the stream or restart the mixer.
          </li>
        </ul>
        <div className="bs-callout">
          <div className="bs-eyebrow">MIX CHANGES NEED A MIXER RESTART</div>
          <p>
            Crossfade and jingle-ratio changes are read by the audio mixer only at
            startup. The <strong>Danger zone</strong> can trigger that restart for you: the
            stream drops for a few seconds and comes back with the new values applied.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">STATIONS</p>
        <h2>More than one station.</h2>
        <p>
          One install can hold several stations — each with its own library pool, DJ
          roster, schedule, jingles, and settings — with exactly one on air at a time.
          The <strong>Stations</strong> page lists them all, and the switcher at the top
          of the sidebar swaps between them from anywhere in the console.
        </p>
        <ul className="bs-list">
          <li>
            <strong>New station</strong> — start fresh (the station walks through
            onboarding when it first goes live) or duplicate the current one, which
            copies settings, personas, schedule, and the analyzed library but starts a
            clean play history. Creating your second station converts the install to the
            multi-station layout automatically; the one already playing isn't touched. An
            install holds up to eight stations.
          </li>
          <li>
            <strong>Make live</strong> — switches the broadcast. The mixer and controller
            restart against the new station's data, so every listener is dropped for
            about ten seconds while it comes back up. Today exactly one station streams
            at a time; broadcasting several at once is planned for later.
          </li>
          <li>
            <strong>Rename and delete</strong> — offline stations can be renamed or
            deleted (deletion erases that station's entire data folder and can't be
            undone). The live station can only be renamed.
          </li>
        </ul>
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
        <div className="bs-manual-figrow">
          <ManualFigure
            src="/screenshots/admin-stats.webp"
            alt="The admin Stats page: listeners over the last 24 hours as a line chart with now, peak, average and low, a breakdown of top referrers and countries, and an LLM usage panel below"
            caption="Stats — listeners over the last day, where they arrived from, and, below the fold, the model calls behind every word the DJ said."
            width={2732}
            height={2048}
          />
          <ManualFigure
            src="/screenshots/admin-debug.webp"
            alt="The admin Debug page: a live health strip for Icecast, Liquidsoap, the LLM, the picker and the tagger, then panels for now-playing, Icecast, the DJ's context, the redacted config with its stream mounts, TTS routing, and recent LLM calls"
            caption="Debug — a live health strip, the exact state the DJ is reading, which mounts are up, who voices the next line, and the last hundred model calls."
            width={2732}
            height={2048}
          />
        </div>
        <p>
          Installing or updating the station rather than tuning it? That's covered in{' '}
          <Link href="/setup" className="bs-link">the setup guide</Link>.
        </p>
      </section>
    </ManualPage>
  );
}
