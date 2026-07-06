import Figure from './Figure';
import EditorialReveal from '../landing/EditorialReveal';
import ObservatoryEmbed from '../observatory/ObservatoryEmbed';

const HABITS = [
  {
    label: 'PICKS THE NEXT TRACK',
    body:
      'The DJ reads the time, the weather, the season, festivals on the calendar, what just played, and any listener requests, then asks an LLM what should come next and pulls a real song from the library.',
  },
  {
    label: 'TALKS BETWEEN SONGS',
    body:
      'Intros, time checks, weather reads, and station idents are all written live in the DJ’s voice, then spoken aloud and ducked under the music. Nothing is pre-recorded.',
  },
  {
    label: 'CHANGES WITH THE HOUR',
    body:
      'A scheduled show can hand the hour to a different persona, signed off live on air, and seat up to three guest co-hosts who trade banter with the host. The 3am host is not the 8am host.',
  },
];

export default function MeetTheVoices() {
  return (
    <EditorialReveal className="bs-section">
      <p className="bs-eyebrow">PART TWO · THE DJ</p>
      <h2>An LLM with a library and a microphone.</h2>
      <p className="text-muted">
        The voice between the tracks is not air talent. It is a persona (a name,
        a soul, a voice engine, a talk frequency) driven by a language model.
      </p>

      <Figure
        src="/screenshots/admin-personas.webp"
        alt="Admin — Personas"
        label="Admin — Personas"
        width={2360}
        height={1640}
        caption="The persona roster: up to twenty-four DJ identities, each with its own voice and habits."
      />

      <div className="bs-dj-cards mt-4">
        {HABITS.map((h) => (
          <article key={h.label} className="bs-whatis-card">
            <div className="bs-eyebrow mb-2">{h.label}</div>
            <p className="m-0 text-[14px] leading-[1.55] text-muted">
              {h.body}
            </p>
          </article>
        ))}
      </div>

      <div className="mt-8">
        <p className="bs-eyebrow">THE DJ’S MIND</p>
        <h3 className="m-0 mt-1 mb-[10px] text-[clamp(22px,2.6vw,30px)] leading-[1.15] font-extrabold tracking-[-0.02em]">
          See the shape of the music.
        </h3>
        <p className="m-0 mb-4 max-w-[64ch] text-[14px] leading-[1.6] text-muted">
          Every track the DJ knows, mapped by how it sounds — clustered by genre,
          lit by energy. This is the library it reaches into when it chooses what
          comes next. Hover a star to read it; click one to see what it would mix
          into. (A sample library below; your own catalogue draws its own.)
        </p>
        <ObservatoryEmbed />
      </div>

      <p className="mt-8 max-w-[64ch] text-[14px] leading-[1.6] text-muted">
        And both the model doing the thinking and the voice doing the talking are
        the operator’s to choose — that is what comes next.
      </p>
    </EditorialReveal>
  );
}
