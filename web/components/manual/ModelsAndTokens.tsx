import Link from 'next/link';
import ManualPage from './ManualPage';

export default function ModelsAndTokens() {
  return (
    <ManualPage
      eyebrow="MANUAL · 09"
      title="Models & tokens."
      intro="The AI DJ can run on a small model on your own hardware or a large hosted one — and a handful of settings let you tune the station for whichever you've picked, trading richness against cost."
      current="/manual/llm"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">THE ROOT CHOICE</p>
        <h2>Which model writes the show.</h2>
        <p>
          Every word the DJ speaks and every track it picks comes from one language
          model, chosen under <strong>Admin &rarr; LLM</strong>. The default is Ollama on
          your own hardware — no API key, no per-token bill — but you can point the
          station at a hosted provider (Anthropic, OpenAI, Google and others) instead.
          Switching reroutes every call immediately, with no redeploy.
        </p>
        <p>
          Big hosted models are more capable but cost money per token; small local models
          are free to run but need a lighter workload to stay coherent. The settings
          below let you match the station to the model — run it <em>lean</em> for a small
          or metered model, or <em>rich</em> for a large capable one.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">RUNNING LEAN</p>
        <h2>For small models &amp; saving tokens.</h2>
        <p>
          If you're on a modest local model, or paying per token and want the bill low,
          these are the dials to turn down. None of them take the DJ off the air — they
          just make it do less work per moment.
        </p>
        <p>
          With these settings in place, a small model runs the whole station
          comfortably — a 9B-class local model such as{' '}
          <strong>Qwen3.5 9B</strong> is plenty for picking tracks and writing the DJ's
          lines. The lean profile keeps each request short and well-shaped, which is
          exactly what a smaller model needs to stay reliable.
        </p>
        <ul className="bs-list">
          <li>
            <strong>Reasoning off</strong> (Admin &rarr; LLM) — stops &ldquo;thinking&rdquo;
            models from writing a long internal monologue before they answer. The DJ
            writes short scripts that don't need it, and an unbounded thinking step makes
            every call balloon on a small model. Off is the safe default.
          </li>
          <li>
            <strong>Picker agent off</strong> (Admin &rarr; LLM) — swaps the
            conversational track-picking agent for the simpler pool picker. The agent
            holds a running chat history and works through tools step by step; the pool
            picker instead hands the model one short, pre-built shortlist and asks for a
            single choice. Far fewer tokens, and a much easier task for a small model to
            get right.
          </li>
          <li>
            <strong>Pause when empty on</strong> (Admin &rarr; LLM) — when nobody is
            listening, the DJ stops picking, talking and writing IDs entirely; the stream
            coasts on the fallback playlist and the DJ wakes up the moment someone tunes
            in. This one is a pure saving — there's no quality cost, since there's no one
            there to hear it.
          </li>
          <li>
            <strong>Concise scripts</strong> (Admin &rarr; Personas) — each persona's
            script length can be <em>concise</em> or <em>extended</em>. Concise keeps
            spoken breaks to a line or two; extended roughly doubles them. Concise means
            fewer tokens out on every segment.
          </li>
          <li>
            <strong>Quiet frequency</strong> (Admin &rarr; Personas) — a persona's
            frequency sets how often it talks, IDs the station and reads the time and
            weather. <em>Quiet</em> makes all of that rarer, so there are simply fewer AI
            calls per hour.
          </li>
          <li>
            <strong>Sound FX off</strong> (Admin &rarr; Sound FX) — with the effects
            library disabled, the DJ is no longer shown the catalogue of stingers when it
            plans a segment, which trims that prompt.
          </li>
        </ul>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">RUNNING RICH</p>
        <h2>For large, capable models.</h2>
        <p>
          On a large hosted model the same dials go the other way — spend the capability
          on a station with more personality and a smarter DJ.
        </p>
        <ul className="bs-list">
          <li>
            <strong>Reasoning on</strong> (Admin &rarr; LLM) — let a thinking model work
            through its choice before answering. Worth it only on a model built for it,
            and on a generous token budget.
          </li>
          <li>
            <strong>Picker agent on</strong> (Admin &rarr; LLM) — the full conversational
            DJ: it remembers the session, reasons about what it has already played, and
            uses tools to dig through the library. Richer and more coherent, but it leans
            on the model being capable.
          </li>
          <li>
            <strong>Extended scripts</strong> (Admin &rarr; Personas) — a storytelling DJ
            that lingers, with longer links between tracks.
          </li>
          <li>
            <strong>Aggressive frequency</strong> (Admin &rarr; Personas) — a busy
            station: frequent IDs, time checks and weather updates.
          </li>
        </ul>
      </section>

      <div className="bs-callout">
        <div className="bs-eyebrow">THE DJ NEVER GOES SILENT</div>
        <p>
          The picker agent has a built-in safety net: if it ever fails or runs too slow,
          the station quietly falls back to the simple pool picker for that track — the
          same path you'd get with the agent switched off. Turning it off just makes that
          lighter path the default rather than the exception.
        </p>
      </div>

      <section className="bs-section">
        <p className="bs-eyebrow">WHERE TO SET THEM</p>
        <h2>All of this lives in the console.</h2>
        <p>
          Every setting here is in the admin console and takes effect without a redeploy —
          most apply to the next thing the DJ does. The full tour of the console is in{' '}
          <Link href="/manual/admin" className="bs-link">Admin &amp; Settings</Link>; how
          the DJ actually picks and talks is in{' '}
          <Link href="/manual/dj" className="bs-link">How the DJ Works</Link>.
        </p>
      </section>
    </ManualPage>
  );
}
