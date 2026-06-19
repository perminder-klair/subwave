import Link from 'next/link';
import ManualPage from './ManualPage';

export default function Faq() {
  return (
    <ManualPage
      eyebrow="MANUAL · 13"
      title="Questions & answers."
      intro="The things people ask most about how SUB/WAVE behaves — how it copes with an empty room, what it needs from a model, and what the moving parts behind the DJ actually do."
      current="/manual/faq"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">AN EMPTY ROOM</p>
        <h2>What happens when no one is listening?</h2>
        <p>
          By default, nothing changes: the station broadcasts the same whether anyone is
          tuned in or not. But there is an optional setting,{' '}
          <strong>Pause when empty</strong>, that changes this. With it on, the moment the
          listener count hits zero the DJ stops doing AI work: no track-picking, no spoken
          links, no station IDs. The music keeps flowing from a fallback playlist so the
          stream never goes silent, and the DJ wakes straight back up the instant someone
          tunes in. It exists to save tokens, and money on a paid model, when there is
          no one there to hear the DJ anyway. See{' '}
          <Link href="/manual/llm" className="bs-link">Models &amp; Tokens</Link>.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">MODEST HARDWARE</p>
        <h2>Does it work with a small model?</h2>
        <p>
          Yes. The AI DJ doesn&rsquo;t need a frontier model; a modest one running on
          your own hardware is plenty. A 9B-class local model such as Qwen3.5 9B
          comfortably picks tracks and writes the DJ&rsquo;s lines, as long as you run the
          station on its <em>lean</em> settings: reasoning off, the simpler track-picker,
          concise scripts. Step up to a 12B-class model like <strong>Gemma 4 12B</strong>{' '}
          and you can leave the richer dials on &mdash; including the full picker agent
          &mdash; while still paying nothing per token. The full set of dials, and what to
          turn which way, is on the{' '}
          <Link href="/manual/llm" className="bs-link">Models &amp; Tokens</Link> page.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">A TAGGED LIBRARY</p>
        <h2>What is mood tagging?</h2>
        <p>
          Every track in the library can carry a <em>mood</em>: a label like calm,
          energetic or reflective. The station tags the library in the background, and the
          DJ leans on those tags to pick music that fits the moment: the time of day, the
          weather, the show that is on. A well-tagged library gives the DJ a far richer
          palette to choose from. You can watch the tagger&rsquo;s progress on the Library
          page in the admin console. Untagged tracks still play; they just don&rsquo;t
          get matched by feel.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">OPERATOR TOOLING</p>
        <h2>What are the &ldquo;deploy&rdquo; and &ldquo;start&rdquo; SUB/WAVE skills?</h2>
        <p>
          These are two helper skills bundled with the project for whoever runs the
          station, used through Claude Code. <strong>subwave-deploy</strong> handles
          installing and updating: a first-time setup from a fresh checkout, or pulling
          the latest code and rebuilding only the parts that actually changed.{' '}
          <strong>subwave-control</strong> is lighter: it simply starts or stops the
          station in development or production mode, with no builds. Day to day you reach
          for <em>control</em>; after a code change you reach for <em>deploy</em>. The
          hands-on steps they automate are written out in{' '}
          <Link href="/setup" className="bs-link">the setup guide</Link>.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">CHOOSING THE NEXT SONG</p>
        <h2>What are the candidate pool and the agentic picker?</h2>
        <p>
          They are two ways the DJ chooses what to play next. The{' '}
          <strong>candidate pool</strong> picker is the straightforward one: it gathers a
          shortlist of tracks from your library (similar songs, similar artists, mood
          matches, recently-added and frequently-played albums), caps it to a couple of
          dozen, and asks the model to pick one from that list.
        </p>
        <p>
          The <strong>agentic picker</strong> is the richer one. It runs as a small
          reasoning loop with a memory of the current session and tools to search the
          library itself, so its choices (and the links between them) stay coherent
          across a run rather than starting cold each time. It is on by default; if it
          ever fails or runs slow, the station quietly falls back to the candidate pool,
          so the music never stops either way. Which one suits you comes down to the
          model; see <Link href="/manual/llm" className="bs-link">Models &amp; Tokens</Link>.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WHEN SOMETHING&rsquo;S OFF</p>
        <h2>Why is there a debug page?</h2>
        <p>
          The admin console&rsquo;s Debug page is a live snapshot of the station&rsquo;s
          inner workings: the most recent AI calls and whether they succeeded, the audio
          mixer&rsquo;s status, and the latest log lines. You don&rsquo;t need it day to
          day, but it is the first place to look when something is off: the stream stalls,
          the DJ goes quiet, or a voice sounds wrong. It turns a vague
          &ldquo;something&rsquo;s broken&rdquo; into a specific, visible cause. More on it
          in <Link href="/manual/admin" className="bs-link">Admin &amp; Settings</Link>.
        </p>
        <p>
          For a deeper look there is also <strong>subwave-log-analysis</strong>, a bundled
          skill used through Claude Code. Where the Debug page shows the live moment, this
          reads the station&rsquo;s full event log over time and reports back on how it
          has been behaving: how often it calls the music library, why the picker keeps
          favouring certain artists, whether the library pool is too narrow, and any
          runtime anomalies. It is the tool for &ldquo;the station works, but something
          feels off&rdquo; rather than an outright break.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">MUSIC LICENSING</p>
        <h2>Do I need a licence to run a SUB/WAVE station?</h2>
        <p>
          Maybe &mdash; it depends on what you stream and who can hear it. SUB/WAVE is
          software; it grants no rights to any music. Listening privately to music you
          own is one thing. Broadcasting it where other people can tune in can count as
          public performance, which is licensed in most countries. Whether you need a
          licence is on you, the operator. <em>(Not legal advice.)</em>
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WHO&rsquo;S RESPONSIBLE</p>
        <h2>Does SUB/WAVE handle licensing for me?</h2>
        <p>
          No. It&rsquo;s a broadcast tool, like the Liquidsoap and Icecast it runs on. It
          doesn&rsquo;t clear, pay, or report anything to any rights body. If your station
          needs a licence, arranging it is the operator&rsquo;s responsibility.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE TWO RIGHTS</p>
        <h2>What rights are involved?</h2>
        <p>
          Usually two: the composition (songwriting) and the sound recording. In the UK
          that&rsquo;s PRS for Music and PPL. In the US it&rsquo;s ASCAP/BMI/SESAC for
          compositions and SoundExchange for recordings. Other countries have their own
          bodies. A public station can touch both.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">SMALL AND PRIVATE</p>
        <h2>It&rsquo;s just me and a few friends and I&rsquo;m not making money &mdash; am I fine?</h2>
        <p>
          Non-commercial and small doesn&rsquo;t automatically mean licence-free; public
          performance rules don&rsquo;t always care whether money changes hands. A private
          stream only you can reach is lower risk than a public URL you&rsquo;ve shared
          around. <em>(Not legal advice &mdash; check your local rules.)</em>
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE SAFE SIDE</p>
        <h2>How do I keep a station clearly on the safe side?</h2>
        <p>
          Keep it private to people you intend, or build it from music that&rsquo;s cleared
          for this: your own recordings, Creative Commons, royalty-free libraries, or
          public domain. SUB/WAVE saves hourly archives, which is the kind of
          record-keeping a licensed station usually wants if you go that route.
        </p>
      </section>
    </ManualPage>
  );
}
