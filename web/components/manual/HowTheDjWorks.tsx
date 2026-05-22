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
          The operator gives the DJ one to ten <em>souls</em> — distinct personas, each
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
          is a separate job — handled by one of four text-to-speech engines the operator
          chooses under <strong>Admin &rarr; TTS voice</strong>. Three run on your own
          hardware, one is hosted.
        </p>
        <ul className="bs-list">
          <li>
            <strong>Piper</strong> — a local engine, and the default. It's compact, runs
            on practically any hardware, and renders speech faster than real time. The
            voice is clear but a little synthetic. Piper is also the station's safety
            net — see below.
          </li>
          <li>
            <strong>Kokoro</strong> — a local neural model that sounds markedly more
            natural, closer to a real broadcaster. It's heavier: it loads a model into
            memory and takes longer per line, so it's happiest with a bit of CPU and RAM
            headroom. It offers a range of voices, with a British selection surfaced in
            the console.
          </li>
          <li>
            <strong>Chatterbox</strong> — a local model that clones a voice from a short
            reference clip, so each persona can have its own distinct sound, and voices
            paralinguistic cues like <em>[laugh]</em> and <em>[sigh]</em> as real sounds.
            The most capable local engine and the heaviest — comfortable on a GPU, slow
            on CPU — and opt-in: the operator bundles it into the controller image.
          </li>
          <li>
            <strong>Cloud</strong> — hosted text-to-speech through OpenAI or ElevenLabs,
            using an API key. The most lifelike and expressive of the four, but it costs
            per use and depends on the network being up.
          </li>
        </ul>
        <p>
          You don't have to commit to one. The operator can assign a different engine{' '}
          <em>per kind</em> of segment — say a rich cloud voice for station IDs, but a
          fast local voice for routine time checks — with everything else falling through
          to a default engine.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">THE DJ NEVER GOES SILENT</div>
          <p>
            If a voice ever fails — a cloud outage, a model that isn't installed — the
            station drops to a local engine automatically. Piper is always there as the
            last resort, so a spoken segment is never lost to a missing voice.
          </p>
        </div>
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
          operator chooses — <em>quiet</em>, <em>moderate</em>, or <em>aggressive</em>. A
          quiet station checks the time every couple of hours and drops the occasional
          ID; an aggressive one gives you full idents and weather updates through the hour.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">SHOWS &amp; SESSIONS</p>
        <h2>It keeps a thread going.</h2>
        <p>
          The DJ runs in <em>sessions</em> — a continuous block with a memory of what it's
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
