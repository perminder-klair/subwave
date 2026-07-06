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
    </ManualPage>
  );
}
