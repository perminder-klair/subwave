import Figure from './Figure';
import EditorialReveal from '../landing/EditorialReveal';

const PANELS = [
  {
    eyebrow: 'DASH',
    title: 'The command center.',
    body:
      'Live status: who is on air, the mood, listener count, weather. See the queue, read the booth log, skip a track, fire a station ID, or send your own words to air as raw or styled voice.',
  },
  {
    eyebrow: 'PERSONAS',
    title: 'The voices on the station.',
    body:
      'Up to twenty-four DJ identities: name, soul, tagline, talk frequency, voice, and which skills each one may use. One persona hosts at a time; a show can hand it the hour and bring guests into the booth. Or install a ready-made host from the community catalog.',
  },
  {
    eyebrow: 'SKILLS',
    title: 'What the DJ does between tracks.',
    body:
      'Each skill is an autonomous segment: a weather check, a news headline, a dig on the song playing, an oddly-specific fact. Toggle each one on, assign it to a persona, or run any one now. Write your own in the built-in editor, or install one from the community exchange.',
    fig: {
      src: '/screenshots/admin-skills.webp',
      label: 'Admin — Skills',
      caption:
        'Skills: the autonomous segments the DJ runs between tracks. Toggle each, run any one now.',
    },
  },
  {
    eyebrow: 'SHOWS',
    title: 'A weekly schedule you paint.',
    body:
      'A 24×7 grid you brush shows onto. Each show carries a persona, a music mood, and a topic brief: genres, eras, the host’s tone. Or anchor it to a Navidrome playlist and let the DJ pick from that. Autonomous hours fill whatever you leave blank.',
    fig: {
      src: '/screenshots/admin-shows.webp',
      label: 'Admin — Weekly Schedule',
      caption:
        'Shows: brush programming onto a 24×7 grid, each slot its own persona and mood.',
    },
  },
  {
    eyebrow: 'LIBRARY',
    title: 'Search, queue, and tag.',
    body:
      'Search the Navidrome library by text, mood, and energy, queue any track, and browse recent additions. The mood tagger walks the library album-by-album and classifies every track.',
  },
  {
    eyebrow: 'PLAYLISTS',
    title: 'A generator, not a spreadsheet.',
    body:
      'Describe a set in a line, drop in a seed track or artist, and the Playlist Builder curates a running order from your library, with an energy arc you shape and mood, genre, era, and tempo to tune. Save it for a show to anchor to, or for the DJ to draw on.',
  },
  {
    eyebrow: 'IMAGING',
    title: 'The sounds between the songs.',
    body:
      'Jingles are the station idents rotated between tracks, SFX are stingers mixed under the DJ’s voice, and beds are instrumentals the host talks over when a link runs long. Render each from the configured voice or a text-to-sound prompt, or import your own audio.',
  },
  {
    eyebrow: 'MOODS',
    title: 'The vocabulary of feeling.',
    body:
      'The words the library is tagged with, and how the DJ reaches for them: which mood each part of the day and each weather condition leans into, a festival calendar that colors the day, and pronunciation fixes for the voice. Edit the list and every show, festival, and auto-pick draws from it.',
  },
  {
    eyebrow: 'DEBUG & STATS',
    title: 'Health and diagnostics.',
    body:
      'Debug and Stats show health, Liquidsoap logs, LLM call history, and usage at a glance. DJ Doc runs a full station check-up and has your own LLM review the findings. Settings (TTS, LLM, mixer, streams) and a danger zone that starts, stops, and restarts the broadcast.',
  },
];

export default function BehindTheDesk() {
  return (
    <EditorialReveal className="bs-section">
      <p className="bs-eyebrow">PART FIVE · THE CONSOLE</p>
      <h2>Behind the desk.</h2>
      <p className="text-muted">
        Everything a listener hears is shaped from one place: a gated admin
        console. This is where the operator actually runs the station.
      </p>

      <Figure
        src="/screenshots/admin-dash.webp"
        alt="Admin — Dash"
        label="Admin — Dash"
        width={2360}
        height={1640}
        caption="The Dash panel: live status, the queue, the booth log, and manual voice control."
      />

      <div className="bs-whatis-grid mt-4">
        {PANELS.map((p) => (
          <article key={p.eyebrow} className="bs-whatis-card">
            <div className="bs-eyebrow mb-2">{p.eyebrow}</div>
            <h3 className="m-0 mb-[10px] text-[clamp(20px,2.2vw,26px)] leading-[1.15] font-extrabold tracking-[-0.02em]">
              {p.title}
            </h3>
            <p className="m-0 text-[14px] leading-[1.55] text-muted">
              {p.body}
            </p>
            {p.fig && (
              <div className="mt-4">
                <Figure
                  src={p.fig.src}
                  alt={p.fig.label}
                  label={p.fig.label}
                  caption={p.fig.caption}
                  width={2360}
                  height={1640}
                />
              </div>
            )}
          </article>
        ))}
      </div>

      <div className="bs-whatis-grid mt-4">
        <Figure
          src="/screenshots/admin-library.webp"
          alt="Admin — Library"
          label="Admin — Library"
          width={2360}
          height={1640}
          caption="Library: search by text, mood, and energy, queue any track, and run the mood tagger."
        />
        <Figure
          src="/screenshots/admin-debug.webp"
          alt="Admin — Debug"
          label="Admin — Debug"
          width={2360}
          height={1640}
          caption="Debug: a health strip, Liquidsoap logs, and recent LLM calls, refreshed live."
        />
      </div>
    </EditorialReveal>
  );
}
