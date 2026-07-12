import Link from 'next/link';
import ManualPage from './ManualPage';

export default function HowTheDjWorks() {
  return (
    <ManualPage
      eyebrow="MANUAL · 05"
      title="How the DJ works."
      intro="There's no human at the desk. An LLM picks every track, writes every line, and a text-to-speech voice reads it out. Here's how that adds up to a station that sounds like a station."
      current="/manual/dj"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">PICKING TRACKS</p>
        <h2>One song ends, the DJ chooses the next.</h2>
        <p>
          Every transition is a decision. By default the DJ runs as a small agent: it digs
          through your library with real tools — similar artists, mood tags, playlists,
          even a &ldquo;sounds like&rdquo; audio search — and picks the next track itself,
          steering by the time of day, the weather, and the current mood. If the agent
          fails or runs slow, the station quietly falls back to a simpler pick: it gathers
          a pool of candidates — songs in a similar mood, similar artists, recently-added
          and frequently-played albums, matching playlists — and the model chooses one
          from the pool.
        </p>
        <p>
          And if the model can&rsquo;t be reached at all, a pre-built playlist keyed to
          the current mood keeps the station on the air. The music never stops; the DJ
          just goes quiet until the model comes back.
        </p>
        <p className="text-muted">
          The two pickers are compared in the <Link href="/manual/faq">FAQ</Link>. A
          persona with DJ mode switched on goes further still — plotting short
          two-or-three-track runs through tempo and key, and timing its mixes to how each
          track actually ends, using the station&rsquo;s{' '}
          <Link href="/manual/analysis">acoustic analysis</Link>.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE DJS</p>
        <h2>A roster of personas, one on the mic.</h2>
        <p>
          The station keeps a roster of <em>personas</em> — each one a name, a soul (the
          character brief behind everything they say), and a few behaviour knobs: their
          own voice, their own language, how chatty they are, how long their scripts run.
          Three ship out of the box — Marlowe, Wren and Hale — and the roster grows to
          forty-eight from the admin console.
        </p>
        <p>
          One DJ is on the air at a time: the persona you&rsquo;ve made active, or whoever
          owns the scheduled show that hour. When the mic changes hands, the handover
          happens on air — the outgoing DJ signs off in their own voice and the incoming
          one picks it up in theirs. Every line is generated fresh; nobody reads from a
          script.
        </p>
        <p className="text-muted">
          There&rsquo;s also a <Link href="/personas">community catalog</Link> of personas
          shared by other stations — browse it, then install any of them from your own
          admin console.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE VOICE ENGINE</p>
        <h2>Local voices, or the cloud.</h2>
        <p>
          The DJ&rsquo;s words are written by the language model, but turning them into
          speech is a separate job. Six text-to-speech engines render the voice: Piper and
          Kokoro run locally, Chatterbox and PocketTTS in an optional sidecar, a Cloud
          engine reaches OpenAI or ElevenLabs, and a Remote engine points at a TTS server
          you run yourself. Each persona can carry its own voice, the operator can mix
          engines <em>per kind</em> of segment, and if one ever fails the station drops to
          a local voice automatically, so the DJ never goes silent.
        </p>
        <p className="text-muted">
          The full rundown is on the{' '}
          <Link href="/manual/voices">Voices &amp; TTS</Link> page: every engine, enabling
          the <code className="bs-code-inline">tts-heavy</code> sidecar, voice cloning, and
          running Chatterbox on a GPU.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WHEN IT TALKS</p>
        <h2>Links, IDs, the time, the weather.</h2>
        <p>
          Between tracks the DJ does what radio DJs do — a short link tying one song to
          the next, a station ID, the time at the top of the hour, and between-track
          segments: a weather note when the conditions change, a news brief, a curiosity,
          an album anniversary, a deep cut from your own library. Spoken segments ride{' '}
          <em>over</em> the music: the track ducks down while the DJ talks, then comes
          back up.
        </p>
        <p>
          How chatty each DJ is, is a <strong>frequency</strong> knob on the persona, on a
          five-step ladder from <em>silent</em> up to <em>aggressive</em>. A silent DJ
          speaks only when asked; a quiet one checks the time every couple of hours and
          drops one station ID an hour; an aggressive one idents three times an hour and
          fills the gaps between with segments.
        </p>
        <p className="text-muted">
          Listener requests get their own on-air moment — the DJ acknowledges each one
          before it plays; see <Link href="/manual/requests">Making Requests</Link>. The
          between-track segments are skills, and you can edit them or write your own —
          see <Link href="/manual/skills">Custom Skills</Link>.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">SHOWS &amp; SESSIONS</p>
        <h2>It keeps a thread going.</h2>
        <p>
          The DJ runs in <em>sessions</em>: a continuous block with a memory of what it&rsquo;s
          already played and said, so its links stay coherent instead of starting cold
          each time. A session can be a scheduled <strong>show</strong> the operator paints
          onto a weekly grid, or an autonomous block keyed to the time of day and the
          dominant mood. A mood turnover mid-run is the same DJ on the same shift — the
          session carries on. A show boundary, or a block ageing past four hours, rolls it
          over to a fresh one with a short handoff note carried forward.
        </p>
        <p>
          Shows can go further. Invite up to three <strong>guest co-hosts</strong> and the
          personas share the studio — the host keeps most of the mic, a guest takes the
          occasional segment, and opt-in <em>banter</em> breaks air short scripted
          exchanges between the voices. Or run a show as a <strong>programme</strong>: a
          produced episode with an intro at the top, one feature segment each hour, and an
          outro at the close.
        </p>
      </section>
    </ManualPage>
  );
}
