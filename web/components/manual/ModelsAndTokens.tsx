import Link from 'next/link';
import ManualPage from './ManualPage';

export default function ModelsAndTokens() {
  return (
    <ManualPage
      eyebrow="MANUAL · 11"
      title="Models & tokens."
      intro="The AI DJ can run on a small model on your own hardware or a large hosted one. This page tells you which models actually hold up — measured, not guessed — and which settings match the station to whichever you pick."
      current="/manual/llm"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">THE ROOT CHOICE</p>
        <h2>Which model writes the show.</h2>
        <p>
          Every word the DJ speaks and every track it picks comes from one language
          model, chosen under <strong>Admin &rarr; LLM</strong>. The default is Ollama on
          your own hardware (no API key, no per-token bill), but you can point the
          station at a hosted provider (Anthropic, OpenAI, Google, OpenRouter and others)
          instead. Switching reroutes every call immediately, with no redeploy.
        </p>
        <p>
          &ldquo;On your own hardware&rdquo; isn&rsquo;t only Ollama — there are three local
          paths, all keyless and all private to your box:
        </p>
        <ul className="bs-list">
          <li>
            <strong>Ollama</strong> — the default. One install, pull a model, done. Ollama&rsquo;s
            cloud models (the <code>:cloud</code> tags) also ride this path: same setup, the
            heavy lifting happens on their hardware.
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
          One thing to internalise before choosing: <strong>the provider is part of the
          choice</strong>. The same model can behave differently through different routes,
          because each provider translates tools and structured output its own way — a model
          that fails through one route can be flawless through another. When you evaluate a
          model, evaluate it through the provider you&rsquo;ll actually run.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">MEASURED, NOT GUESSED</p>
        <h2>Which models hold up.</h2>
        <p>
          SUB/WAVE ships a benchmark that drives every kind of call the DJ makes — track
          picks, talk segments, listener requests, scripts, banter, programme plans — against
          any model, in both picker modes, and scores the output against the station&rsquo;s own
          rules. The table below is from a full run across the models the community actually
          uses (station configured lean, reasoning off):
        </p>
        <ul className="bs-list">
          <li>
            <strong>Gemma 4 31B</strong> (Ollama cloud) — the best result on record: near-perfect
            across the board, <em>including the full picker agent</em>, at one-to-four seconds a
            call. If you want the richest station without a per-token bill, this is it.
          </li>
          <li>
            <strong>MiniMax M2.7</strong> (Ollama cloud) — the other agent-capable option.
            Excellent everywhere except multi-hour programme plans, which it writes correctly
            but slowly (minutes, not seconds — tolerable for a once-per-episode call).
          </li>
          <li>
            <strong>GPT-5 Mini</strong> (hosted) — strong, but no longer clearly better than the
            free options above: under pressure it repeats artists back-to-back more than any
            local Gemma, and it occasionally serves the wrong track on an exact-title request.
            If cost is why you&rsquo;re leaving it, the bench says you lose little.
          </li>
          <li>
            <strong>Qwen3.5 9B</strong> — the small-model floor. On the pool picker it&rsquo;s
            fast and flawless; its quirks are cosmetic (wordy request replies). Run it lean and
            it runs the whole station.
          </li>
          <li>
            <strong>Gemma 4 12B</strong> (local, e.g. <code>locca serve gemma4</code>) — fine for
            a pool-mode station: picks, requests, scripts and plans all pass. Just don&rsquo;t
            give it the picker agent — that&rsquo;s the one job it genuinely can&rsquo;t do.
          </li>
          <li>
            <strong>Skip for now:</strong> Kimi K2.6 (fails unpredictably across unrelated call
            types) and DeepSeek V4 Flash as a primary (it invents track ids under pressure —
            fine as a fallback leg, not as the DJ).
          </li>
        </ul>
        <p>
          Two patterns worth knowing whatever you run: the Gemma family at every size shares
          the same habits (it can repeat an artist when the shortlist pressures it to, and it
          fumbles feature choices on three-hour programme plans), and the multi-hour programme
          plan is the hardest single call in the system — the only one that dented every model
          tested. If a show misbehaves, suspect the plan before the model.
        </p>
        <p>
          Running from a clone? You can put any candidate model through the same battery
          before trusting it on air: <code>npm run llm-bench</code> in{' '}
          <code>controller/</code> benchmarks it across every call kind and prints a
          comparison table. The DJ Doctor&rsquo;s LLM checks cover the everyday health of
          whatever you&rsquo;ve picked.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">RUNNING LEAN</p>
        <h2>For small models &amp; saving tokens.</h2>
        <p>
          If you&rsquo;re on a modest local model, or paying per token and want the bill low,
          these are the dials to turn down. None of them take the DJ off the air. They
          just make it do less work per moment.
        </p>
        <ul className="bs-list">
          <li>
            <strong>Picker agent off</strong> (Admin &rarr; LLM) — the big one. With it off,
            the station runs <em>everything</em> in one-call-per-moment style: track picks
            come from a short pre-built shortlist, and the talk segments (weather, news,
            curiosities) fetch their data first and make a single call too, instead of running
            a tool-using agent. Far fewer tokens, and a task shape small models get right —
            this is the setting that makes the 9B–12B class reliable.
          </li>
          <li>
            <strong>Reasoning off</strong> (Admin &rarr; LLM) — stops &ldquo;thinking&rdquo;
            models from writing a long internal monologue before they answer. The DJ writes
            short scripts that don&rsquo;t need it, and an unbounded thinking step can balloon
            a call from one second to minutes — or eat the whole reply. Off is the safe
            default; the station knows how to genuinely switch thinking off per provider,
            including the model families that ignore the polite version of the request.
          </li>
          <li>
            <strong>Pause when empty on</strong> (Admin &rarr; LLM) — when nobody is
            listening, the DJ stops picking, talking and writing IDs entirely; the stream
            coasts on the fallback playlist and the DJ wakes up the moment someone tunes
            in. This one is a pure saving: there&rsquo;s no quality cost, since there&rsquo;s no
            one there to hear it.
          </li>
          <li>
            <strong>Concise scripts</strong> (Admin &rarr; Personas) — each persona&rsquo;s
            script length runs from <em>one-liner</em> through <em>concise</em> and{' '}
            <em>extended</em> to <em>storyteller</em>. Concise keeps spoken breaks to a
            line or two; the longer stops double or triple them.
          </li>
          <li>
            <strong>Quiet frequency</strong> (Admin &rarr; Personas) — a persona&rsquo;s
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
        <p>
          With the lean profile in place, <strong>Qwen3.5 9B</strong> or a local{' '}
          <strong>Gemma 4 12B</strong> runs the whole station comfortably — picks, requests,
          talk breaks, even programme shows — while paying nothing per token.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">RUNNING RICH</p>
        <h2>For large, capable models.</h2>
        <p>
          On a capable model the same dials go the other way: spend the capability on a
          station with more personality and a smarter DJ.
        </p>
        <ul className="bs-list">
          <li>
            <strong>Picker agent on</strong> (Admin &rarr; LLM) — the full conversational
            DJ: it remembers the session, reasons about what it has already played, and
            uses tools to dig through the library. Richer and more coherent — but it&rsquo;s
            a genuinely harder job, and the bench is blunt about who can do it:{' '}
            <strong>Gemma 4 31B</strong> (Ollama cloud), <strong>MiniMax M2.7</strong> and
            hosted models of GPT-5-Mini&rsquo;s class run it reliably; the 9B–12B locals do
            not. You don&rsquo;t need to guess — turn it on and watch the booth log; every
            agent miss falls back to the pool picker anyway.
          </li>
          <li>
            <strong>Reasoning on</strong> (Admin &rarr; LLM) — let a thinking model work
            through its choice before answering. Worth trying only on a model built for it
            and a generous token budget; the picker and other structured calls suppress
            thinking regardless, so this mainly buys more considered scripts.
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
          same path you&rsquo;d get with the agent switched off. Turning it off just makes that
          lighter path the default rather than the exception.
        </p>
      </div>

      <section className="bs-section">
        <p className="bs-eyebrow">A SECOND, SMALLER MODEL</p>
        <h2>How the DJ knows each track&rsquo;s mood.</h2>
        <p>
          The DJ picks partly by <em>mood</em> — mellow mornings, brighter afternoons, a
          wind-down late at night. To know each track&rsquo;s mood it leans on the{' '}
          <strong>library tagger</strong>, which uses a second, much smaller{' '}
          <strong>embedding model</strong> — not the chat model that writes the show.
        </p>
        <p>
          Rather than ask the chat model about every track (slow and expensive on a big
          library), the tagger embeds each track once, has the chat model tag a small,
          representative <strong>seed set</strong>, then <strong>propagates</strong> moods
          and energy out to everything else by similarity. That&rsquo;s roughly ten times fewer
          model calls than tagging track by track.
        </p>
        <p>
          By default the embedding model <strong>follows your LLM provider</strong>, so
          there&rsquo;s usually nothing extra to set up — an Ollama-local station gets{' '}
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
            all. A DJ on one of those works fine, but the tagger can&rsquo;t follow it, so the
            console only lists <em>embedding-capable</em> providers in the tagger dropdown
            (Ollama, OpenAI, Google, OpenRouter, locca, OpenAI-compatible). If you don&rsquo;t see
            your chat provider there, that&rsquo;s why — pick Ollama (local and free) for the
            embedding step and leave the DJ where it is.
          </li>
          <li>
            <strong>Provider vs. model — mind the difference on a router.</strong> &ldquo;DeepSeek&rdquo;
            is a <em>provider</em> (no embeddings), but it&rsquo;s also a <em>model</em> you can run{' '}
            <em>through OpenRouter</em>. Those aren&rsquo;t the same: pick the <strong>OpenRouter</strong>{' '}
            provider with a DeepSeek chat model and your DJ speaks via DeepSeek while embeddings
            go through OpenRouter&rsquo;s own embeddings endpoint — by default{' '}
            <code>openai/text-embedding-3-small</code>. OpenRouter, Requesty and the like carry
            everything (chat and embeddings); the bare provider named after a chat-only company
            does not.
          </li>
          <li>
            <strong>locca and OpenAI-compatible need a dedicated embedding server</strong> —
            one llama.cpp process can&rsquo;t serve chat and embeddings at once. With locca that&rsquo;s
            a second command, <code>locca embed</code>, on its own port; the console can
            detect it for you.
          </li>
          <li>
            <strong>Which one should I pick?</strong> Any embedding model at{' '}
            <strong>768 dimensions or more</strong> is fine for mood similarity — favour a fast,
            cheap one over a big &ldquo;best-in-class&rdquo; model. Good baselines:{' '}
            <code>nomic-embed-text</code> (local, free, 768-d) if you run Ollama, or{' '}
            <code>text-embedding-3-small</code> (cloud, cheap, 1536-d) otherwise. The exact
            model matters far less than <em>picking one and sticking with it</em> — see the
            next note.
          </li>
        </ul>
        <p>
          <strong>One catch worth internalising:</strong> the vector index is built at your
          embedding model&rsquo;s dimension, so <em>changing the embedding model means re-embedding
          the whole library</em> (Admin &rarr; Library tagger &rarr; Re-scan &rarr; &ldquo;Re-embed
          all tracks&rdquo;). Changing the <em>chat</em> model never needs this — but if embeddings
          are set to &ldquo;follow the LLM,&rdquo; switching your DJ <em>provider</em> quietly changes the
          embedding model too. The console pins embeddings to your library&rsquo;s model and warns
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
