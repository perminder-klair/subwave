import Link from 'next/link';
import SetupPage from './SetupPage';
import CodeBlock from "@/components/CodeBlock";

export default function MacOs() {
  return (
    <SetupPage
      eyebrow="SETUP · MACOS"
      title="Run it on a Mac."
      meta="macOS 13+ · Intel or Apple Silicon · Docker Desktop, OrbStack or Colima"
      intro="A Mac is the quickest place to try SUB/WAVE: the CLI ships a native darwin binary, the core images are multi-arch, and Docker Desktop already wires up the one bit of host networking the stack needs. This page is the Quick Start with the Mac-shaped details filled in — which runtime, how much memory, and what changes on Apple Silicon."
      current="/setup/macos"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">STEP BY STEP</p>
        <h2>From nothing to on-air.</h2>

        <div className="bs-step">
          <div className="bs-step-num">01</div>
          <div className="bs-step-body">
            <h3>Install a container runtime</h3>
            <p>
              Anything that gives you <code className="bs-code-inline">docker</code> and{' '}
              <code className="bs-code-inline">docker compose</code> works.{' '}
              <a
                href="https://www.docker.com/products/docker-desktop/"
                target="_blank"
                rel="noreferrer"
                className="bs-link"
              >
                Docker Desktop ↗
              </a>{' '}
              is the default choice;{' '}
              <a
                href="https://orbstack.dev/"
                target="_blank"
                rel="noreferrer"
                className="bs-link"
              >
                OrbStack ↗
              </a>{' '}
              is lighter on battery and RAM. Colima works too if you prefer a
              CLI-only VM. Whichever you pick, it has to be <em>running</em>{' '}
              before any <code className="bs-code-inline">subwave</code> command —
              everything below is Docker underneath.
            </p>
            <CodeBlock>{`docker compose version`}</CodeBlock>
            <p className="text-muted">
              You want Compose v2 (the space-separated form, printed as{' '}
              <code className="bs-code-inline">v2.x</code>). If that command
              errors, the runtime isn't up yet.
            </p>
          </div>
        </div>

        <div className="bs-step">
          <div className="bs-step-num">02</div>
          <div className="bs-step-body">
            <h3>Give the VM enough room</h3>
            <p>
              On a Mac every container runs inside a Linux VM with a fixed slice
              of your RAM, so this is the one dial worth checking before you
              start. Docker Desktop → <strong>Settings → Resources</strong>:
            </p>
            <ul className="bs-list">
              <li>
                <strong>4 GB</strong> — the base station (broadcast, controller,
                web, caddy) plus the lean analyzer.
              </li>
              <li>
                <strong>8 GB+</strong> — if you'll enable the heavy analyzer
                (CLAP + Demucs) or the{' '}
                <code className="bs-code-inline">tts-heavy</code> voice sidecar.
                Their compose memory ceilings are{' '}
                <code className="bs-code-inline">6g</code> and{' '}
                <code className="bs-code-inline">10g</code> respectively, and a
                VM smaller than that just OOM-kills them mid-load.
              </li>
            </ul>
            <p className="text-muted">
              Disk: budget ~3 GB for the core images, another ~2 GB if you pull a
              heavy flavour, plus whatever the stem cache is set to (off by
              default).
            </p>
          </div>
        </div>

        <div className="bs-step">
          <div className="bs-step-num">03</div>
          <div className="bs-step-body">
            <h3>Install SUB/WAVE</h3>
            <p>
              The installer detects <code className="bs-code-inline">darwin-arm64</code>{' '}
              or <code className="bs-code-inline">darwin-x64</code> and drops a
              single binary in <code className="bs-code-inline">/usr/local/bin</code>{' '}
              (it will ask for <code className="bs-code-inline">sudo</code>; pass{' '}
              <code className="bs-code-inline">--dir ~/.local/bin</code> to avoid
              that). Then it offers to scaffold and start.
            </p>
            <CodeBlock>{`curl -fsSL https://cli.getsubwave.com | sh`}</CodeBlock>
            <CodeBlock>{`subwave setup`}</CodeBlock>
            <p>
              <code className="bs-code-inline">init</code> writes the install to{' '}
              <code className="bs-code-inline">~/subwave</code> and brings the
              stack up; <code className="bs-code-inline">setup</code> asks for
              Navidrome, your LLM, and the DJ persona, then renders the jingles (on Jellyfin or Plex, pick it at /onboarding instead).
              Full walkthrough on{' '}
              <Link href="/setup/quick-start" className="bs-link">Quick Start</Link>.
            </p>
          </div>
        </div>

        <div className="bs-step">
          <div className="bs-step-num">04</div>
          <div className="bs-step-body">
            <h3>Tune in</h3>
            <CodeBlock>{`open http://localhost:7700`}</CodeBlock>
            <p>
              Port <code className="bs-code-inline">7700</code> is the only host
              port the prod stack binds. If you remap it with{' '}
              <code className="bs-code-inline">CADDY_PORT</code>, steer clear of{' '}
              <code className="bs-code-inline">5000</code> and{' '}
              <code className="bs-code-inline">7000</code> — macOS AirPlay
              Receiver squats on both, and the failure looks like a broken
              container rather than a taken port.
            </p>
            <CodeBlock>{`subwave doctor`}</CodeBlock>
            <p className="text-muted">
              The full diagnostic sweep: containers, music source reachability, the
              LLM, and whether the stream is actually on air.
            </p>
          </div>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">APPLE SILICON</p>
        <h2>What's native and what's emulated.</h2>
        <p>
          The station itself is native on M-series Macs. Only the two optional
          PyTorch images are x86-only, because their upstream wheels are:
        </p>
        <table className="bs-rebuild-table mt-3">
          <thead>
            <tr>
              <th>Image</th>
              <th>Arch</th>
              <th>On Apple Silicon</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>broadcast · controller · web · caddy</td>
              <td>amd64 + arm64</td>
              <td>Native</td>
            </tr>
            <tr>
              <td>
                <code className="bs-code-inline">analyzer</code> (lean — bpm, key,
                loudness, outro)
              </td>
              <td>amd64 + arm64</td>
              <td>Native</td>
            </tr>
            <tr>
              <td>
                <code className="bs-code-inline">analyzer-heavy</code> (CLAP +
                Demucs)
              </td>
              <td>amd64 only</td>
              <td>Emulated — slow</td>
            </tr>
            <tr>
              <td>
                <code className="bs-code-inline">tts-heavy</code> (Chatterbox +
                PocketTTS)
              </td>
              <td>amd64 only</td>
              <td>Emulated — slow</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-3">
          The <code className="bs-code-inline">tts-heavy</code> service carries its
          own <code className="bs-code-inline">platform: linux/amd64</code> pin, so
          it needs no platform setting of its own — but it is profile-gated and
          stays down until you ask for it by name with{' '}
          <code className="bs-code-inline">docker compose --profile tts-heavy up -d</code>{' '}
          (or <code className="bs-code-inline">COMPOSE_PROFILES=tts-heavy</code> in{' '}
          <code className="bs-code-inline">.env</code>). The heavy analyzer is the
          other way round — it replaces a service that is already running, so it
          needs both the opt-in and the platform default:
        </p>
        <CodeBlock lang="env">{`# .env
ANALYZER_HEAVY=1
DOCKER_DEFAULT_PLATFORM=linux/amd64`}</CodeBlock>
        <div className="bs-callout">
          <div className="bs-eyebrow">TURN ROSETTA ON FIRST</div>
          <p>
            Docker Desktop → <strong>Settings → General → Use Rosetta for
            x86/amd64 emulation</strong>. Without it the emulated images fall back
            to QEMU, which is several times slower again. Even with it, a full
            CLAP + Demucs pass over a large library is an overnight job on a
            laptop. Leave the analyzer lean unless you want
            &ldquo;sounds-like&rdquo; search and vocal-aware transitions.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">MAC-SPECIFIC GOTCHAS</p>
        <h2>The four things that catch people.</h2>

        <div className="bs-callout">
          <div className="bs-eyebrow">MUSIC SERVER ON THE SAME MAC? NOT LOCALHOST</div>
          <p>
            Inside a container, <code className="bs-code-inline">localhost</code>{' '}
            is the container. Point the wizard at{' '}
            <code className="bs-code-inline">http://host.docker.internal:4533</code>{' '}
            (Navidrome; Jellyfin is <code className="bs-code-inline">:8096</code>, Plex{' '}
            <code className="bs-code-inline">:32400</code>) instead — every compose file already maps that name to the host
            gateway. Same rule for an Ollama box running on the Mac:{' '}
            <code className="bs-code-inline">http://host.docker.internal:11434</code>.
          </p>
        </div>

        <div className="bs-callout">
          <div className="bs-eyebrow">A SLEEPING MAC IS A DEAD STATION</div>
          <p>
            The stream stops when the machine sleeps, and listeners get a dropped
            connection rather than silence. For a Mac mini acting as the station
            box, set <strong>System Settings → Displays → Advanced → Prevent
            automatic sleeping</strong>. On a laptop, keep it plugged in, or wrap
            long sessions in <code className="bs-code-inline">caffeinate</code>:
          </p>
          <CodeBlock>{`caffeinate -di &`}</CodeBlock>
        </div>

        <div className="bs-callout">
          <div className="bs-eyebrow">KEEP STATE ON THE INTERNAL DISK</div>
          <p>
            <code className="bs-code-inline">state/</code> holds{' '}
            <code className="bs-code-inline">library.db</code>, a SQLite database
            in WAL mode. Put it on an SMB or NFS share and file locking gets
            unreliable; put it outside your home directory and Docker Desktop
            needs the path added under <strong>Settings → Resources → File
            sharing</strong> before the bind mount will work. The default{' '}
            <code className="bs-code-inline">~/subwave/state</code> avoids both.
          </p>
        </div>

        <div className="bs-callout">
          <div className="bs-eyebrow">START ON LOGIN</div>
          <p>
            Every service is <code className="bs-code-inline">restart: unless-stopped</code>,
            so the station comes back by itself — as long as Docker does. Tick{' '}
            <strong>Start Docker Desktop when you log in</strong> in Settings →
            General and the box recovers from a reboot unattended.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">DAY TO DAY</p>
        <h2>Running it from the shell.</h2>
        <p>
          The CLI works from any directory once installed — no{' '}
          <code className="bs-code-inline">cd</code> into the install dir.
        </p>
        <div className="bs-cmd-list">
          <div className="bs-cmd">
            <CodeBlock>{`subwave status`}</CodeBlock>
            <p>Stack + now-playing snapshot.</p>
          </div>
          <div className="bs-cmd">
            <CodeBlock>{`subwave logs controller`}</CodeBlock>
            <p>Tail a service. Omit the name for everything.</p>
          </div>
          <div className="bs-cmd">
            <CodeBlock>{`subwave listen`}</CodeBlock>
            <p>Open the player in your browser.</p>
          </div>
          <div className="bs-cmd">
            <CodeBlock>{`subwave update`}</CodeBlock>
            <p>Pull new images, recreate only what changed.</p>
          </div>
        </div>
        <p>
          Hacking on the source rather than running a release? The dev compose
          file is the Mac smoke-test path —{' '}
          <Link href="/setup/development" className="bs-link">Development</Link>{' '}
          covers it. Something not right?{' '}
          <Link href="/setup/updates" className="bs-link">Updates &amp; Help</Link>{' '}
          has the troubleshooting checklist.
        </p>
      </section>
    </SetupPage>
  );
}
