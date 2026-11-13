import Link from 'next/link';
import ManualPage from './ManualPage';
import ManualFigure from './ManualFigure';
import CodeBlock from '@/components/CodeBlock';

export default function AcousticAnalysis() {
  return (
    <ManualPage
      eyebrow="MANUAL · 13"
      title="Acoustic analysis."
      intro="Beyond mood and energy tags, SUB/WAVE can listen to each track and measure how it actually sounds: tempo, key, loudness, and, optionally, a 'sounds-like' fingerprint and where the vocals sit. The DJ leans on these to build smoother, better-matched sets. The basics run out of the box; the heavier dimensions are one line away."
      current="/manual/analysis"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">WHAT IT MEASURES</p>
        <h2>Tempo, key &amp; loudness — on by default.</h2>
        <p>
          The <code className="bs-code-inline">analyzer</code> is a small service that ships
          and starts <strong>by default</strong> alongside the controller: no profile, no
          flag. It measures each track&rsquo;s <strong>tempo (BPM)</strong>,{' '}
          <strong>musical key</strong>, <strong>intro length</strong> and{' '}
          <strong>loudness</strong>, and hands them to the DJ as tie-breakers for smoother
          transitions: a tempo-matched, harmonically-close next track, and the right window
          to talk over an intro.
        </p>
        <p>
          The default image is <strong>lean</strong> (librosa only, no PyTorch), so it
          stays small and runs natively on both amd64 and arm64 (a NAS, a Pi, Apple
          Silicon). Coverage climbs on the <Link href="/admin/library">Library</Link> page
          under <strong>Acoustic analysis · bpm / key</strong>.
        </p>
        <ManualFigure
          src="/screenshots/admin-library.webp"
          alt="The admin Library page, with a one-line acoustic-analysis strip reading bpm/key 99 percent, sounds-like 99 percent, vocal off, beneath the mood-and-energy tagging bar"
          caption="Coverage lives on the Library page — one line under the tagging bar, a percentage per dimension. Expand it to start a pass or watch one run."
          width={2732}
          height={2048}
        />
        <div className="bs-callout">
          <div className="bs-eyebrow">&ldquo;ENGINE OFF&rdquo;?</div>
          <p>
            The acoustic-engine indicator is a <em>live reachability check</em>, not a saved
            setting. If the analyzer container is stopped, existing data still drives picks;
            only new analysis pauses until it&rsquo;s back.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE HEAVY TIER</p>
        <h2>&ldquo;Sounds-like&rdquo; &amp; vocal detection are opt-in.</h2>
        <p>
          Two richer dimensions need a heavier model stack (CPU PyTorch — roughly
          +0.8&nbsp;GB of image over the lean default), so they are <strong>not</strong> in
          the default analyzer:
        </p>
        <ul className="bs-list">
          <li>
            <strong>Sounds-like (CLAP)</strong> — a learned audio fingerprint, so the DJ can
            find tracks that <em>sound</em> similar (not just share tags) and build sonic
            journeys.
          </li>
          <li>
            <strong>Vocal activity (Demucs)</strong> — separates vocal from instrumental
            energy, so the DJ knows how long it can talk before the singing starts.
          </li>
        </ul>
        <p>
          Both live in a separate{' '}
          <code className="bs-code-inline">subwave-analyzer-heavy</code> image. If you turn
          on <strong>Audio fingerprint</strong> or <strong>Vocal activity</strong> on the
          Library page while running the lean analyzer, you&rsquo;ll see a note that the
          engine can&rsquo;t produce them; that&rsquo;s the cue to switch to the heavy image
          below. (This is entirely separate from the <code className="bs-code-inline">tts-heavy</code>{' '}
          voices sidecar, which is TTS-only.)
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">ENABLING IT</p>
        <h2>One line, no rebuild.</h2>
        <p>
          Set the switch in your root <code className="bs-code-inline">.env</code> and
          recreate the analyzer — Compose re-pulls it as{' '}
          <code className="bs-code-inline">subwave-analyzer-heavy</code>:
        </p>
        <CodeBlock>{`# root .env
ANALYZER_HEAVY=1`}</CodeBlock>
        <CodeBlock>{`docker compose up -d analyzer`}</CodeBlock>
        <p>By install type:</p>
        <ul className="bs-list">
          <li>
            <strong>CLI / cloned / raw compose.</strong> Add the line to{' '}
            <code className="bs-code-inline">.env</code> and run{' '}
            <code className="bs-code-inline">docker compose up -d analyzer</code>. The{' '}
            <code className="bs-code-inline">subwave setup</code> wizard also offers it.
          </li>
          <li>
            <strong>Unraid split-stack.</strong> Add{' '}
            <code className="bs-code-inline">ANALYZER_HEAVY=1</code> to your{' '}
            <code className="bs-code-inline">.env</code>, <strong>Save</strong>, then{' '}
            <strong>Pull &amp; Up</strong>.
          </li>
          <li>
            <strong>Unraid one-click (AIO).</strong> There&rsquo;s no second container to
            swap; point the container&rsquo;s <strong>Repository</strong> at{' '}
            <code className="bs-code-inline">ghcr.io/perminder-klair/subwave-aio-heavy</code>{' '}
            and re-pull.
          </li>
        </ul>
        <div className="bs-callout">
          <div className="bs-eyebrow">ON ARM64</div>
          <p>
            The heavy image is <strong>amd64-only</strong> (the CPU-torch stack). On an
            arm64 host (Pi, Apple Silicon, arm cloud) also set{' '}
            <code className="bs-code-inline">DOCKER_DEFAULT_PLATFORM=linux/amd64</code>; it
            runs under emulation (slower, but analysis is a one-time per-track pass).
          </p>
        </div>
        <p>
          Model weights download lazily into the analyzer&rsquo;s cache the first time you
          run a sounds-like / vocals pass. Once the heavy analyzer is up, enable the
          dimensions on the <Link href="/admin/library">Library</Link> page and run a
          backfill.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">NEEDS THE INTERNET ONCE</div>
          <p>
            The weights are <strong>not baked into the image</strong> — the heavy analyzer
            fetches them from huggingface.co the first time it needs them, so the heavy tier
            has a one-time outbound dependency that everything else about the station
            doesn&rsquo;t. On a host with no reach the load fails, sounds-like coverage stays
            at zero, and the analysis pass keeps re-targeting the same tracks every run. The
            Library panel names the cause when this happens. It is <em>not</em> the lean/heavy
            image split, so switching images won&rsquo;t help. Let it out once, or pre-seed the
            cache offline; the recipe is in <code className="bs-code-inline">docs/tts-heavy.md</code>.
            After fixing it, restart whatever holds the analyzer: the sidecar container on a
            compose install, or the controller itself on an AIO or local venv, where the worker
            is a child of it. The failure is remembered until you do, which is what stops the pass
            churning; the Library panel names the right process for your install.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">ON AN NVIDIA GPU</p>
        <h2>The CUDA flavour — same features, much faster.</h2>
        <p>
          Hosts with an NVIDIA card can run CLAP and Demucs on the GPU, a big speed-up on
          deep library ingestion. Decode, resampling, and the baseline acoustic features
          still use the CPU; CUDA accelerates the model stages rather than replacing the
          whole analyzer. Sounds-like backfills skip already-current baseline features and
          batch each track&rsquo;s CLAP windows into one CUDA model call. It&rsquo;s a compose{' '}
          <em>overlay</em>, not an <code className="bs-code-inline">.env</code> toggle (a
          GPU reservation can&rsquo;t be switched from <code className="bs-code-inline">.env</code>):
        </p>
        <CodeBlock>{`docker compose -f docker-compose.yml -f docker-compose.analyzer-gpu.yml up -d`}</CodeBlock>
        <p>
          That swaps the analyzer to the{' '}
          <code className="bs-code-inline">subwave-analyzer-cuda</code> image (everything{' '}
          <code className="bs-code-inline">-heavy</code> does, on CUDA), so{' '}
          <code className="bs-code-inline">ANALYZER_HEAVY</code> is unnecessary while the
          overlay is applied. Requirements: the NVIDIA driver + Container Toolkit on the
          host, nothing else (the CUDA runtime rides inside the image). The default
          build covers Turing (RTX 20-series) and newer; for an older card, add the tag
          named for its architecture to <code className="bs-code-inline">.env</code>,
          such as <code className="bs-code-inline">ANALYZER_CUDA_TAG=pascal</code> for a
          GTX 10-series, and the overlay pulls the build that still supports it. The
          worker runs
          one small test op on the card first: if the GPU isn&rsquo;t visible, or the
          image has no kernels for it, it logs a warning naming the card and the image
          tag that suits it, then falls back to CPU (even with{' '}
          <code className="bs-code-inline">ANALYZE_DEVICE=cuda</code>); analysis never
          fails over device selection. Demucs on CPU is slow, so treat that warning as
          something to fix.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">NON-COMPOSE INSTALLS</div>
          <p>
            Point the analyzer container&rsquo;s image at{' '}
            <code className="bs-code-inline">ghcr.io/perminder-klair/subwave-analyzer-cuda</code>{' '}
            and pass the GPU through (<code className="bs-code-inline">--gpus all</code> or
            your platform&rsquo;s equivalent). Its tags match the all-in-one&rsquo;s
            below: <code className="bs-code-inline">:pascal</code> for a GTX 10-series,
            and <code className="bs-code-inline">:latest</code> needs Turing or newer.
          </p>
        </div>
        <div className="bs-callout">
          <div className="bs-eyebrow">ALL-IN-ONE (ONE-CLICK) INSTALLS</div>
          <p>
            The AIO has no separate analyzer to swap, so there&rsquo;s no overlay: the GPU
            rides on the image. Point the container at{' '}
            <code className="bs-code-inline">ghcr.io/perminder-klair/subwave-aio-cuda</code>{' '}
            (the same heavy features on CUDA) at the tag named for your card&rsquo;s
            architecture, such as <code className="bs-code-inline">:pascal</code> for a GTX
            10-series (<code className="bs-code-inline">:latest</code> needs Turing or
            newer), and hand it the card
            (<code className="bs-code-inline">--gpus all</code>, or on Unraid the nvidia
            runtime plus <code className="bs-code-inline">NVIDIA_VISIBLE_DEVICES</code>;{' '}
            <a className="bs-link" href="/setup/unraid#acoustic-analysis">
              step-by-step here
            </a>
            ). Everything above about device selection and VRAM applies unchanged.
          </p>
          <p>
            Don&rsquo;t point an AIO install at{' '}
            <code className="bs-code-inline">subwave-analyzer-cuda</code>: that&rsquo;s the
            bare analyzer micro-service, and swapping to it replaces your whole station
            with just an analyzer.
          </p>
        </div>
        <p>
          Sharing the card with a local TTS or LLM? After ~5 idle minutes the worker drops
          its models out of VRAM and reloads them on the next request
          (<code className="bs-code-inline">ANALYZE_IDLE_UNLOAD_S</code> tunes the window;{' '}
          <code className="bs-code-inline">0</code> keeps them resident). Pair it with{' '}
          <strong>Quiet times</strong> below and a long scan frees the GPU whenever
          listeners are tuned in.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">QUIET TIMES</p>
        <h2>Let analysis yield to the live station.</h2>
        <p>
          A bulk pass over a large library runs for hours, and on a homelab it competes
          with local LLM / TTS, and the stream itself, for the same CPU or GPU.{' '}
          <strong>Quiet times</strong> (off by default, on the{' '}
          <Link href="/admin/library">Library</Link> page next to the sounds-like and vocal
          controls) pauses any analysis run while someone is listening, and resumes once
          the stream has had no listeners for the configured window (default 10 minutes).
        </p>
        <p>
          The gate checks between tracks, so a listener tuning in pauses the pass within
          ~30 seconds; the running view shows{' '}
          <em>&ldquo;Waiting for quiet&rdquo;</em> while it holds. It applies to manual{' '}
          <strong>Analyse</strong> runs too — a pass outlives the click, so the bypass is
          turning the toggle off, not the button. If the listener count can&rsquo;t be read
          at all (Icecast down), analysis proceeds; a stats outage never stalls a library
          scan.
        </p>
      </section>
    </ManualPage>
  );
}
