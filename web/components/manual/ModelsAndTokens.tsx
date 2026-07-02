import Link from 'next/link';
import ManualPage from './ManualPage';

export default function ModelsAndTokens() {
  return (
    <ManualPage
      eyebrow="MANUAL · 11"
      title="Models & tokens."
      intro="The AI DJ can run on a small model on your own hardware or a large hosted one, and a handful of settings let you tune the station for whichever you've picked, trading richness against cost."
      current="/manual/llm"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">THE ROOT CHOICE</p>
        <h2>Which model writes the show.</h2>
        <p>
          Every word the DJ speaks and every track it picks comes from one language
          model, chosen under <strong>Admin &rarr; LLM</strong>. The default is Ollama on
          your own hardware (no API key, no per-token bill), but you can point the
          station at a hosted provider (Anthropic, OpenAI, Google and others) instead.
          Switching reroutes every call immediately, with no redeploy.
        </p>
        <p>
          &ldquo;On your own hardware&rdquo; isn't only Ollama — there are three local
          paths, all keyless and all private to your box:
        </p>
        <ul className="bs-list">
          <li>
            <strong>Ollama</strong> — the default. One install, pull a model, done.
          </li>
          <li>
            <strong>locca</strong> — a first-class, one-command local model server
            (<code>locca serve &lt;model&gt;</code>) built on llama.cpp. No key, a sensible
            host default, and the onboarding wizard can detect it for you.{' '}
            <a
              href="https://github.com/perminder-klair/locca"
              className="bs-link"
              target="_blank"
              rel="noreferrer"
            >
              locca on GitHub ↗
            </a>
          </li>
          <li>
            <strong>OpenAI-compatible</strong> — any self-hosted server that speaks the
            OpenAI API (llama.cpp, vLLM, LM Studio); you supply its URL.
          </li>
        </ul>
        <p>
          Thinking models are handled for you: with <strong>Reasoning off</strong> the
          station tells a local model to skip its internal monologue, so a small model
          stays fast and on-task (more on that below).
        </p>
        <p>
          Big hosted models are more capable but cost money per token; small local models
          are free to run but need a lighter workload to stay coherent. The settings
          below let you match the station to the model: run it <em>lean</em> for a small
          or metered model, or <em>rich</em> for a large capable one.
        </p>
        <p>
          If you want a single recommendation, a 12B-class local model such as{' '}
          <strong>Gemma 4 12B</strong> is the sweet spot — serve it with{' '}
          <code>locca serve gemma4</code>, or as <code>gemma4:12b</code> on Ollama. It's
          free and private on your own box, yet capable enough to run the station's{' '}
          <em>richest</em> setting — the full conversational picker agent — without falling
          over. A smaller 9B-class model still works on lean settings, and a large hosted
          model buys you more headroom again; Gemma 4 12B is the comfortable middle that
          most stations should reach for first.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">RUNNING LEAN</p>
        <h2>For small models &amp; saving tokens.</h2>
        <p>
          If you're on a modest local model, or paying per token and want the bill low,
          these are the dials to turn down. None of them take the DJ off the air. They
          just make it do less work per moment.
        </p>
        <p>
          With these settings in place, a small model runs the whole station
          comfortably: even a 9B-class local model such as{' '}
          <strong>Qwen3.5 9B</strong> is plenty for picking tracks and writing the DJ's
          lines. The lean profile keeps each request short and well-shaped, which is
          exactly what a smaller model needs to stay reliable. Step up one size to a
          12B-class model like <strong>Gemma 4 12B</strong> and you can leave more of the
          rich dials on — including the picker agent — while still paying nothing per
          token.
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
            in. This one is a pure saving: there's no quality cost, since there's no one
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
          On a large hosted model the same dials go the other way: spend the capability
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
            on the model being capable. You don't need a hosted model for it, though — a
            tool-capable 12B-class local model like <strong>Gemma 4 12B</strong> runs the
            agent reliably on your own hardware.
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
          the station quietly falls back to the simple pool picker for that track, the
          same path you'd get with the agent switched off. Turning it off just makes that
          lighter path the default rather than the exception.
        </p>
      </div>

      <section className="bs-section">
        <p className="bs-eyebrow">A SECOND, SMALLER MODEL</p>
        <h2>How the DJ knows each track's mood.</h2>
        <p>
          The DJ picks partly by <em>mood</em> — mellow mornings, brighter afternoons, a
          wind-down late at night. To know each track's mood it leans on the{' '}
          <strong>library tagger</strong>, which uses a second, much smaller{' '}
          <strong>embedding model</strong> — not the chat model that writes the show.
        </p>
        <p>
          Rather than ask the chat model about every track (slow and expensive on a big
          library), the tagger embeds each track once, has the chat model tag a small,
          representative <strong>seed set</strong>, then <strong>propagates</strong> moods
          and energy out to everything else by similarity. That's roughly ten times fewer
          model calls than tagging track by track.
        </p>
        <p>
          By default the embedding model <strong>follows your LLM provider</strong>, so
          there's usually nothing extra to set up — an Ollama-local station gets{' '}
          <code>nomic-embed-text</code> for free. Two things are worth knowing if you
          stray from that:
        </p>
        <ul className="bs-list">
          <li>
            <strong>Anthropic has no embedding model</strong> — if your DJ runs on Claude,
            point embeddings at Ollama or OpenAI instead.
          </li>
          <li>
            <strong>Some providers do chat only</strong> — the <code>deepseek</code> and
            Vercel AI <code>gateway</code> <em>providers</em> have no embeddings endpoint at
            all. A DJ on one of those works fine, but the tagger can't follow it, so the
            console only lists <em>embedding-capable</em> providers in the tagger dropdown
            (Ollama, OpenAI, Google, OpenRouter, locca, OpenAI-compatible). If you don't see
            your chat provider there, that's why — pick Ollama (local and free) for the
            embedding step and leave the DJ where it is.
          </li>
          <li>
            <strong>Provider vs. model — mind the difference on a router.</strong> "DeepSeek"
            is a <em>provider</em> (no embeddings), but it's also a <em>model</em> you can run{' '}
            <em>through OpenRouter</em>. Those aren't the same: pick the <strong>OpenRouter</strong>{' '}
            provider with a DeepSeek chat model and your DJ speaks via DeepSeek while embeddings
            go through OpenRouter's own embeddings endpoint — by default{' '}
            <code>openai/text-embedding-3-small</code>. OpenRouter, Requesty and the like carry
            everything (chat and embeddings); the bare provider named after a chat-only company
            does not.
          </li>
          <li>
            <strong>locca and OpenAI-compatible need a dedicated embedding server</strong> —
            one llama.cpp process can't serve chat and embeddings at once. With locca that's
            a second command, <code>locca embed</code>, on its own port; the console can
            detect it for you.
          </li>
          <li>
            <strong>Which one should I pick?</strong> Any embedding model at{' '}
            <strong>768 dimensions or more</strong> is fine for mood similarity — favour a fast,
            cheap one over a big "best-in-class" model. Good baselines:{' '}
            <code>nomic-embed-text</code> (local, free, 768-d) if you run Ollama, or{' '}
            <code>text-embedding-3-small</code> (cloud, cheap, 1536-d) otherwise. The exact
            model matters far less than <em>picking one and sticking with it</em> — see the
            next note.
          </li>
        </ul>
        <p>
          <strong>One catch worth internalising:</strong> the vector index is built at your
          embedding model's dimension, so <em>changing the embedding model means re-embedding
          the whole library</em> (Admin &rarr; Library tagger &rarr; Re-scan &rarr; "Re-embed
          all tracks"). Changing the <em>chat</em> model never needs this — but if embeddings
          are set to "follow the LLM," switching your DJ <em>provider</em> quietly changes the
          embedding model too. The console pins embeddings to your library's model and warns
          you before that happens, so the safe move is to pin an embedding provider once and
          leave it.
        </p>
        <p>
          It all lives under <strong>Admin &rarr; Library tagger</strong>, and you can see
          the tagged library laid out in{' '}
          <Link href="/manual/observatory" className="bs-link">Library Observatory</Link>.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WHERE TO SET THEM</p>
        <h2>All of this lives in the console.</h2>
        <p>
          Every setting here is in the admin console and takes effect without a redeploy;
          most apply to the next thing the DJ does. The full tour of the console is in{' '}
          <Link href="/manual/admin" className="bs-link">Admin &amp; Settings</Link>; how
          the DJ actually picks and talks is in{' '}
          <Link href="/manual/dj" className="bs-link">How the DJ Works</Link>.
        </p>
      </section>
    </ManualPage>
  );
}
