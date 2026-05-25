import Figure from './Figure';
import EditorialReveal from '../landing/EditorialReveal';

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
      'A scheduled show can hand the hour to a different persona, each with its own name, personality, voice, and how often it speaks. The 3am host is not the 8am host.',
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
        caption="The persona roster: up to twelve DJ identities, each with its own voice and habits."
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

      <p className="mt-2 max-w-[64ch] text-[14px] leading-[1.6] text-muted">
        The model behind it is the operator’s choice: a local Ollama box, or a
        hosted provider like Anthropic, OpenAI, or Google. The voice is just as
        swappable: local engines Piper, Kokoro, and Chatterbox run on-device, or
        a cloud voice from OpenAI or ElevenLabs. Change either one in the console
        and the next spoken line uses it. No redeploy.
      </p>
    </EditorialReveal>
  );
}
