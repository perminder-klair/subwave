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
          Every time a track finishes, the DJ picks what follows. It builds a pool of
          candidates from your library — songs in a similar mood, similar artists,
          recently-added and frequently-played albums, matching playlists — and the LLM
          chooses from that pool, steering by the time of day, the weather, and the
          current mood. When nothing's been requested, it runs a fallback playlist so the
          music never stops.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE VOICES</p>
        <h2>Personas, picked at random.</h2>
        <p>
          The operator gives the DJ one to ten <em>souls</em>: distinct personas, each
          with its own name and character. Before each spoken moment the station picks one
          at random, so the voice on air shifts through the day rather than reading from a
          single script. Each line is generated fresh; the DJ doesn't repeat itself.
        </p>
        <p className="text-muted">
          The spoken audio is rendered by a text-to-speech engine — a fast local voice by
          default, or a more natural one if the operator configures it.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE VOICE ENGINE</p>
        <h2>Local voices, or the cloud.</h2>
        <p>
          The DJ's words are written by the language model, but turning them into speech
          is a separate job. Five text-to-speech engines render the voice: Piper and
          Kokoro run locally, Chatterbox and PocketTTS in an optional sidecar, and a Cloud
          engine reaches OpenAI, ElevenLabs, or any self-hosted server. The operator can
          mix them <em>per kind</em> of segment, and if one ever fails the station drops
          to a local voice automatically, so the DJ never goes silent.
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
          the next, a station ID, the time at the top of the hour, a weather note when the
          conditions change. Spoken segments ride <em>over</em> the music: the track ducks
          down while the DJ talks, then comes back up.
        </p>
        <p>
          How chatty the station is depends on a <strong>frequency</strong> setting the
          operator chooses: <em>quiet</em>, <em>moderate</em>, or <em>aggressive</em>. A
          quiet station checks the time every couple of hours and drops the occasional
          ID; an aggressive one gives you full idents and weather updates through the hour.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">SHOWS &amp; SESSIONS</p>
        <h2>It keeps a thread going.</h2>
        <p>
          The DJ runs in <em>sessions</em>: a continuous block with a memory of what it's
          already played and said, so its links stay coherent instead of starting cold
          each time. A session can be a scheduled <strong>show</strong> the operator paints
          onto a weekly grid, or an autonomous block keyed to the time of day and the
          dominant mood. When the show changes or the block ages out, the session rolls
          over to a fresh one and carries a short handoff forward.
        </p>
      </section>
    </ManualPage>
  );
}
