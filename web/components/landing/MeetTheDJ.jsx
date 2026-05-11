'use client';

// Playful, character-driven introduction to the on-air voice. Deliberately
// abstract — never leads with the operator-configurable name. The point is
// to communicate the *kind* of presence behind the mic, not to advertise
// whoever happens to be on the desk this week.

const HABITS = [
  { tag: 'ALWAYS', text: 'reads the actual weather before talking about it' },
  { tag: 'NEVER',  text: 'says "and now", "coming up next", or "next up"' },
  { tag: 'ALWAYS', text: 'keeps it to 2–4 sentences. Then back to the music.' },
  { tag: 'NEVER',  text: 'repeats the artist and title robotically' },
  { tag: 'ALWAYS', text: 'references what just played, not what\'s coming' },
  { tag: 'NEVER',  text: 'sounds like a presenter trying to sound like a DJ' },
];

const INPUTS = [
  'time of day',
  'open-meteo weather',
  'sikh + UK festival calendar',
  'what just played',
  'what played an hour ago',
  'your last request',
  'the dominant mood of the room',
];

const TOOLS = [
  { name: 'Ollama',     role: 'the picking brain' },
  { name: 'Piper TTS',  role: 'the speaking voice' },
  { name: 'Liquidsoap', role: 'ducks the bed under the link' },
  { name: 'Subsonic',   role: 'the crates' },
];

export default function MeetTheDJ() {
  return (
    <section className="bs-dj">
      <p className="bs-eyebrow">WHO'S ON THE DECKS</p>

      <div className="bs-dj-hero">
        <div className="bs-dj-glyph" aria-hidden="true">
          <div className="bs-dj-vinyl" />
        </div>
        <div className="bs-dj-intro">
          <h2 className="bs-dj-handle">
            The night<br />shift.
          </h2>
          <p className="bs-dj-soul">
            <span className="bs-dj-quote">“</span>
            Warm, slightly understated, never corny — late-night BBC 6 Music presenter; observant, dry humour, specific.
          </p>
          <p className="bs-dj-byline">
            That's the brief. The DJ is an LLM with a personality, a clock, a
            weather feed, and a copy of your music library. Operator-configurable.
            Different on every SUB/WAVE.
          </p>
        </div>
      </div>

      <div className="bs-dj-cards">
        <article className="bs-dj-card">
          <header className="bs-eyebrow">HOUSE RULES</header>
          <ul className="bs-dj-rules">
            {HABITS.map((h, i) => (
              <li key={i}>
                <span className={`bs-dj-tag bs-dj-tag-${h.tag.toLowerCase()}`}>{h.tag}</span>
                <span>{h.text}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="bs-dj-card">
          <header className="bs-eyebrow">WHAT THE PICK IS BASED ON</header>
          <ul className="bs-dj-tags">
            {INPUTS.map((t) => <li key={t}>{t}</li>)}
          </ul>
          <p className="bs-dj-foot">
            The picker reads all of this every time it asks "what should come
            next?". You can hear it noticing.
          </p>
        </article>

        <article className="bs-dj-card">
          <header className="bs-eyebrow">TOOLS OF THE TRADE</header>
          <table className="bs-dj-tools">
            <tbody>
              {TOOLS.map((t) => (
                <tr key={t.name}>
                  <td>{t.name}</td>
                  <td>{t.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="bs-dj-foot">
            No air talent. No producer. No subscription. One box, one stream,
            one taste.
          </p>
        </article>
      </div>
    </section>
  );
}
