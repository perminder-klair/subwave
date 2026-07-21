import Link from 'next/link';
import ManualPage from './ManualPage';
import CodeBlock from '@/components/CodeBlock';

export default function AcousticAnalysis() {
  return (
    <ManualPage
      eyebrow="MANUAL · 13"
      title="Acoustic analysis."
      intro="Beyond mood and energy tags, SUB/WAVE can listen to each track and measure how it actually sounds — tempo, key, loudness, and, optionally, a 'sounds-like' fingerprint and where the vocals sit. The DJ leans on these to build smoother, better-matched sets. The basics run out of the box; the heavier dimensions are one line away."
      current="/manual/analysis"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">WHAT IT MEASURES</p>
        <h2>Tempo, key &amp; loudness — on by default.</h2>
        <p>
          The <code className="bs-code-inline">analyzer</code> is a small service that ships
          and starts <strong>by default</strong> alongside the controller — no profile, no
          flag. It measures each track&rsquo;s <strong>tempo (BPM)</strong>,{' '}
          <strong>musical key</strong>, <strong>intro length</strong> and{' '}
          <strong>loudness</strong>, and hands them to the DJ as tie-breakers for smoother
          transitions: a tempo-matched, harmonically-close next track, and the right window
          to talk over an intro.
        </p>
        <p>
          The default image is <strong>lean</strong> — librosa only, no PyTorch — so it
          stays small and runs natively on both amd64 and arm64 (a NAS, a Pi, Apple
          Silicon). Coverage climbs on the <Link href="/admin/library">Library</Link> page
          under <strong>Acoustic analysis · bpm / key</strong>.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">&ldquo;ENGINE OFF&rdquo;?</div>
          <p>
            The acoustic-engine indicator is a <em>live reachability check</em>, not a saved
            setting. If the analyzer container is stopped, existing data still drives picks —
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
          engine can&rsquo;t produce them — that&rsquo;s the cue to switch to the heavy image
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
            swap — point the container&rsquo;s <strong>Repository</strong> at{' '}
            <code className="bs-code-inline">ghcr.io/perminder-klair/subwave-aio-heavy</code>{' '}
            and re-pull.
          </li>
        </ul>
        <div className="bs-callout">
          <div className="bs-eyebrow">ON ARM64</div>
          <p>
            The heavy image is <strong>amd64-only</strong> (the CPU-torch stack). On an
            arm64 host (Pi, Apple Silicon, arm cloud) also set{' '}
            <code className="bs-code-inline">DOCKER_DEFAULT_PLATFORM=linux/amd64</code> — it
            runs under emulation (slower, but analysis is a one-time per-track pass).
          </p>
        </div>
        <p>
          Model weights download lazily into the analyzer&rsquo;s cache the first time you
          run a sounds-like / vocals pass. Once the heavy analyzer is up, enable the
          dimensions on the <Link href="/admin/library">Library</Link> page and run a
          backfill.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">ON AN NVIDIA GPU</p>
        <h2>The CUDA flavour — same features, much faster.</h2>
        <p>
          Hosts with an NVIDIA card can run the heavy stack on the GPU instead of pinning
          CPU cores — a big speed-up on deep library ingestion. It&rsquo;s a compose{' '}
          <em>overlay</em>, not an <code className="bs-code-inline">.env</code> toggle (a
          GPU reservation can&rsquo;t be switched from <code className="bs-code-inline">.env</code>):
        </p>
        <CodeBlock>{`docker compose -f docker-compose.yml -f docker-compose.analyzer-gpu.yml up -d`}</CodeBlock>
        <p>
          That swaps the analyzer to the{' '}
          <code className="bs-code-inline">subwave-analyzer-cuda</code> image — everything{' '}
          <code className="bs-code-inline">-heavy</code> does, on CUDA —{' '}so{' '}
          <code className="bs-code-inline">ANALYZER_HEAVY</code> is unnecessary while the
          overlay is applied. Requirements: the NVIDIA driver + Container Toolkit on the
          host, nothing else (the CUDA runtime rides inside the image). If the GPU
          isn&rsquo;t actually visible, the worker logs a warning and falls back to CPU —
          analysis never fails over device selection.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">NON-COMPOSE INSTALLS</div>
          <p>
            Point the analyzer container&rsquo;s image at{' '}
            <code className="bs-code-inline">ghcr.io/perminder-klair/subwave-analyzer-cuda</code>{' '}
            and pass the GPU through (<code className="bs-code-inline">--gpus all</code> or
            your platform&rsquo;s equivalent). The AIO one-click container stays CPU-only —
            GPU analysis needs the split stack.
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
          with local LLM / TTS — and the stream itself — for the same CPU or GPU.{' '}
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
          at all (Icecast down), analysis proceeds — a stats outage never stalls a library
          scan.
        </p>
      </section>
    </ManualPage>
  );
}
