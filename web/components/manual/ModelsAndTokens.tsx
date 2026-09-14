import Link from 'next/link';
import ManualPage from './ManualPage';
import LlmBenchTable from './LlmBenchTable';

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
          station at a hosted provider (Anthropic, OpenAI, Azure OpenAI, Google, OpenRouter
          and others) instead. Switching reroutes every call immediately, with no
          redeploy.
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
          <strong>The provider is part of the choice.</strong> The same model can behave
          differently through different routes, because each provider translates tools and
          structured output its own way: a model that fails through one route can be
          flawless through another. When you evaluate a model, evaluate it through the
          provider you&rsquo;ll actually run.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">YOUR OWN CLOUD</p>
        <h2>Azure OpenAI is three things away from OpenAI.</h2>
        <p>
          <strong>Azure OpenAI</strong> runs the same GPT models on a resource you own, on
          your subscription and inside your compliance boundary. Everything the station
          does works there &mdash; the DJ, the picker, and the library tagger&rsquo;s
          embeddings. Three things differ from picking plain OpenAI, and all three are
          places operators get stuck.
        </p>
        <ul className="bs-list">
          <li>
            <strong>The Model field is a deployment name, not a model id.</strong> On Azure
            you deploy a model and give that deployment a name &mdash; it can be{' '}
            <code>gpt-4o-mini</code>, or it can be <code>radio-dj</code>. That name is what
            goes in Model. Nothing can guess it, so unlike every other provider there is no
            default: leaving it blank is an error rather than a fallback.
          </li>
          <li>
            <strong>The resource endpoint is required.</strong> There is no hosted address
            to fall back to. Paste the <em>bare root</em> from the portal (your resource
            &rarr; Keys and Endpoint), e.g.{' '}
            <code>https://my-resource.openai.azure.com</code>. An Azure AI Foundry{' '}
            <em>project</em> endpoint works as-is too. Only if your resource is pinned to a
            dated API version should you paste the endpoint with its{' '}
            <code>?api-version=&hellip;</code> query attached &mdash; that switches to the
            older per-deployment address, which cannot reach the newest models, so avoid it
            unless you have to.
          </li>
          <li>
            <strong>Your embedding deployment is separate from your chat deployment.</strong>{' '}
            The library tagger needs its own: deploy{' '}
            <code>text-embedding-3-small</code> on the same resource and enter{' '}
            <em>that</em> deployment&rsquo;s name under Library tagger &rarr; Embedding.
            Leave the endpoint there blank and it inherits the one from the LLM tab, so an
            Azure DJ needs nothing extra.
          </li>
        </ul>
        <p>
          <strong>If your deployment runs o-series or GPT-5.x, turn on &ldquo;Reasoning
          deployment&rdquo;.</strong> Those models reject <code>temperature</code>,{' '}
          <code>top_p</code> and <code>max_tokens</code>, which GPT-4-class deployments
          accept &mdash; and because the deployment name is an alias, nothing in the request
          says which kind you have. The switch is how you tell the station. Leave it off and
          the station still works it out from Azure&rsquo;s own rejections; turning it on
          just means the first request is already right. Leave it off for GPT-4-class
          deployments, and for <code>gpt-5-chat</code>, which despite the name is not a
          reasoning model &mdash; though <code>gpt-5.1-chat</code> is.
        </p>
        <p>
          Two things Azure does not offer through this path: the{' '}
          <strong>codex</strong> variants, plus <code>gpt-5-pro</code> and{' '}
          <code>o3-pro</code>, are served only by Azure&rsquo;s Responses API, and the
          station speaks Chat Completions &mdash; the one surface every other deployment
          serves. Pick a non-codex deployment.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">MEASURED, NOT GUESSED</p>
        <h2>Which models hold up.</h2>
        <p>
          SUB/WAVE ships a benchmark that drives every kind of call the DJ makes (track
          picks, talk segments, listener requests, scripts, banter, programme plans) against
          any model, in both picker modes, and scores the output against the station&rsquo;s own
          rules. The table below is the running record, and it grows as more models and
          providers get benched (station configured lean unless noted):
        </p>
        <LlmBenchTable />
        <p>
          Reading it for a recommendation: pick an <strong>agent-capable</strong> row if you
          want the full conversational picker — <strong>Gemini 3.5 Flash</strong> leads the
          table outright, its <strong>Flash-Lite</strong> sibling matches the 31B class at the
          fastest picks benched, and <strong>Gemma 4 31B on Ollama cloud</strong> remains the
          best keyless option. Pick any healthy <strong>pool-mode</strong> row for a lean
          station (<strong>Qwen3.5 9B</strong> is the small floor, and a local{' '}
          <strong>Gemma 4 12B</strong> — <code>locca serve gemma4</code> — does the same job
          keylessly on your own box). <strong>GPT-5.6 Luna via OpenRouter</strong> is the
          newest agent entry, and so far the only model benched that spends its full
          multi-round discovery budget — up to three library searches per pick before it
          commits. Remember the route in the second line of each model
          cell is part of the result — the same model through a different provider can score
          differently, and two of the scores above changed by 20+ points once bugs in{' '}
          <em>our own</em> thinking-suppression plumbing were found and fixed. The bench
          checks that too, now.
        </p>
        <p>
          Two habits show up whatever you run: the Gemma family at every size shares
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
            this is the setting that makes the 9B–12B class reliable. If you&rsquo;d
            rather keep the agent on but cheaper, set <em>Discovery rounds per
            pick</em> to 1 instead.
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
            <strong>Sound FX off</strong> (Admin &rarr; Imaging &rarr; SFX) — with the effects
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
            <strong>Gemma 4 31B</strong> (Ollama cloud), <strong>GPT-5.6 Luna</strong>{' '}
            (OpenRouter) and hosted models of GPT-5-Mini&rsquo;s class run it reliably;
            the 9B–12B locals do not. You don&rsquo;t need to guess — turn it on and watch the booth log; every
            agent miss falls back to the pool picker anyway.
          </li>
          <li>
            <strong>Discovery rounds per pick</strong> (Admin &rarr; LLM) — how many
            times the picker agent may search the library before it has to commit to a
            track. <em>0 = auto</em>: one round on self-hosted servers (the single
            cornered call is what keeps small models honest), three on hosted
            providers — enough to seed from the current track, refine on what came
            back, and cross-check by sound before choosing. Raise it if you run a
            genuinely capable model on your own hardware; auto is deliberately cautious
            there. Every round is a separate model call and they all share the agent
            deadline, so this dial is also where agent-mode tokens and pick latency go —
            the backup model carries its own copy. Track picks only: talk segments
            always fetch their data in a single round.
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
          <code>nomic-embed-text</code> for free. Two things matter if you stray from
          that:
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
          <strong>One catch:</strong> the vector index is built at your
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
