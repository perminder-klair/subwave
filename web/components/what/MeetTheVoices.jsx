import Figure from './Figure';

const HABITS = [
  {
    label: 'PICKS THE NEXT TRACK',
    body:
      'The DJ reads the time, the weather, the season, festivals on the calendar, what just played, and any listener requests — then asks an LLM what should come next and pulls a real song from the library.',
  },
  {
    label: 'TALKS BETWEEN SONGS',
    body:
      'Intros, time checks, weather reads, and station idents are all written live in the DJ’s voice, then spoken aloud and ducked under the music. Nothing is pre-recorded.',
  },
  {
    label: 'CHANGES WITH THE HOUR',
    body:
      'A scheduled show can hand the hour to a different persona — each with its own name, personality, voice, and how often it speaks. The 3am host is not the 8am host.',
  },
];

export default function MeetTheVoices() {
  return (
    <section className="bs-section">
      <p className="bs-eyebrow">PART TWO · THE DJ</p>
      <h2>An LLM with a library and a microphone.</h2>
      <p className="muted">
        The voice between the tracks is not air talent. It is a persona — a name,
        a soul, a voice engine, and a talk frequency — driven by a language model.
      </p>

      <Figure
        label="Admin — Personas"
        caption="The persona roster: up to twelve DJ identities, each with its own voice and habits."
      />

      <div className="bs-dj-cards" style={{ marginTop: 16 }}>
        {HABITS.map((h) => (
          <article key={h.label} className="bs-whatis-card">
            <div className="bs-eyebrow" style={{ marginBottom: 8 }}>{h.label}</div>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: 'var(--muted)' }}>
              {h.body}
            </p>
          </article>
        ))}
      </div>

      <p
        style={{
          marginTop: 8,
          fontSize: 14,
          lineHeight: 1.6,
          color: 'var(--muted)',
          maxWidth: '64ch',
        }}
      >
        The model behind it is the operator’s choice — a local Ollama box, or a
        hosted provider like Anthropic, OpenAI, or Google. The voice is just as
        swappable: bundled Piper and Kokoro run on-device, or a cloud voice from
        OpenAI or ElevenLabs. Change either one in the console and the next
        spoken line uses it. No redeploy.
      </p>
    </section>
  );
}
