import Figure from './Figure';
import EditorialReveal from '../landing/EditorialReveal';
import ObservatoryEmbed from '../observatory/ObservatoryEmbed';

const HABITS = [
  {
    title: 'Picks the next track.',
    body:
      'The DJ reads the time, the weather, the season, festivals on the calendar, what just played, and any listener requests, then asks an LLM what should come next and pulls a real song from the library.',
  },
  {
    title: 'Talks between songs.',
    body:
      'Intros, time checks, weather reads, and station idents are all written live in the DJ’s voice, then spoken aloud and ducked under the music. Nothing is pre-recorded.',
  },
  {
    title: 'Changes with the hour.',
    body:
      'A scheduled show can hand the hour to a different persona, signed off live on air, and seat up to three guest co-hosts who trade banter with the host. The 3am host is not the 8am host.',
  },
] as const;

// Picking tracks is the DJ's core act, so it leads at a larger size; talking
// and changing hosts are the supporting habits that stack beside it.
const [LEAD_HABIT, ...REST_HABITS] = HABITS;

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

      <div className="bs-dj-habits mt-4">
        <article className="bs-whatis-card">
          <h3 className="m-0 mb-[10px] text-[clamp(24px,3vw,34px)] leading-[1.12] font-extrabold tracking-[-0.02em]">
            {LEAD_HABIT.title}
          </h3>
          <p className="m-0 text-[15px] leading-[1.6] text-muted">
            {LEAD_HABIT.body}
          </p>
        </article>

        <div className="bs-dj-habits__rest">
          {REST_HABITS.map((h) => (
            <article key={h.title} className="bs-whatis-card">
              <h3 className="m-0 mb-[10px] text-[clamp(20px,2.2vw,26px)] leading-[1.15] font-extrabold tracking-[-0.02em]">
                {h.title}
              </h3>
              <p className="m-0 text-[14px] leading-[1.55] text-muted">
                {h.body}
              </p>
            </article>
          ))}
        </div>
      </div>

      <div className="mt-8">
        <h3 className="m-0 mb-[10px] text-[clamp(22px,2.6vw,30px)] leading-[1.15] font-extrabold tracking-[-0.02em]">
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
