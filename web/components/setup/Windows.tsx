import Link from 'next/link';
import SetupPage from './SetupPage';
import CodeBlock from "@/components/CodeBlock";

export default function Windows() {
  return (
    <SetupPage
      eyebrow="SETUP · WINDOWS"
      title="Run it on Windows."
      meta="Windows 10 21H2+ / Windows 11 · WSL2 + Docker Desktop"
      intro="SUB/WAVE runs on Windows through WSL2 — the containers are Linux containers, and the CLI is a Linux binary. There's no subwave.exe and there doesn't need to be: a WSL2 shell gives you the same one-line install everyone else gets. If you'd rather not touch WSL at all, the second path down this page is plain docker compose from PowerShell."
      current="/setup/windows"
    >
      <section className="bs-section">
        <div className="bs-callout">
          <div className="bs-eyebrow">WHICH PATH?</div>
          <p>
            <strong>Path A (WSL2)</strong> is the recommended one: you get{' '}
            <code className="bs-code-inline">subwave setup</code>,{' '}
            <code className="bs-code-inline">doctor</code>,{' '}
            <code className="bs-code-inline">update</code> and the rest, identical
            to a Linux host. <strong>Path B (PowerShell)</strong> skips WSL and
            drives Docker Desktop with two files and{' '}
            <code className="bs-code-inline">docker compose</code> — fewer moving
            parts, but you manage the stack by hand.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">PATH A · WSL2 + DOCKER DESKTOP</p>
        <h2>The full CLI, on Windows.</h2>

        <div className="bs-step">
          <div className="bs-step-num">01</div>
          <div className="bs-step-body">
            <h3>Install WSL2</h3>
            <p>
              From an <strong>Administrator</strong> PowerShell. This installs
              WSL2 and Ubuntu in one go, then wants a reboot:
            </p>
            <CodeBlock lang="powershell">{`wsl --install`}</CodeBlock>
            <p className="text-muted">
              Already have WSL? Make sure the distro is on version 2 —{' '}
              <code className="bs-code-inline">wsl -l -v</code> should print{' '}
              <code className="bs-code-inline">2</code> in the VERSION column.
              Docker Desktop's integration doesn't work with WSL1.
            </p>
          </div>
        </div>

        <div className="bs-step">
          <div className="bs-step-num">02</div>
          <div className="bs-step-body">
            <h3>Install Docker Desktop and enable the distro</h3>
            <p>
              Install{' '}
              <a
                href="https://www.docker.com/products/docker-desktop/"
                target="_blank"
                rel="noreferrer"
                className="bs-link"
              >
                Docker Desktop ↗
              </a>{' '}
              with the <strong>WSL2 backend</strong>, then turn on integration for
              your distro, which is the step most people miss:{' '}
              <strong>Settings → Resources → WSL integration</strong>, toggle{' '}
              <code className="bs-code-inline">Ubuntu</code>, apply and restart.
              Without it, <code className="bs-code-inline">docker</code> simply
              isn't on PATH inside the shell you're about to use.
            </p>
            <p>Open a WSL shell and check:</p>
            <CodeBlock>{`docker compose version`}</CodeBlock>
          </div>
        </div>

        <div className="bs-step">
          <div className="bs-step-num">03</div>
          <div className="bs-step-body">
            <h3>Install SUB/WAVE inside WSL</h3>
            <p>
              From the WSL shell (not PowerShell). The installer sees{' '}
              <code className="bs-code-inline">linux-x64</code> and installs the
              same binary a Linux server gets:
            </p>
            <CodeBlock>{`curl -fsSL https://cli.getsubwave.com | sh`}</CodeBlock>
            <CodeBlock>{`subwave setup`}</CodeBlock>
            <p>
              Accept the default install location —{' '}
              <code className="bs-code-inline">~/subwave</code>{' '}
              <em>inside WSL</em>. See the callout below on why that matters.
            </p>
          </div>
        </div>

        <div className="bs-step">
          <div className="bs-step-num">04</div>
          <div className="bs-step-body">
            <h3>Tune in from Windows</h3>
            <p>
              WSL2 forwards localhost, so the station is reachable from your
              normal Windows browser with no extra plumbing:
            </p>
            <CodeBlock>{`http://localhost:7700`}</CodeBlock>
            <p>
              Other devices on the network need the host's LAN address plus a
              firewall rule for TCP 7700 (Windows Defender Firewall → Inbound
              Rules). Check the stack any time with:
            </p>
            <CodeBlock>{`subwave doctor`}</CodeBlock>
          </div>
        </div>

        <div className="bs-callout">
          <div className="bs-eyebrow">KEEP IT OFF /MNT/C</div>
          <p>
            Install into the WSL filesystem (<code className="bs-code-inline">~/subwave</code>),
            never <code className="bs-code-inline">/mnt/c/...</code>. Windows
            drives are mounted over a translation layer, and{' '}
            <code className="bs-code-inline">state/library.db</code> is SQLite in
            WAL mode: file locking across that boundary is both slow and
            unreliable, which shows up as random &ldquo;database is locked&rdquo;
            errors during an analysis pass rather than as a clean failure.
          </p>
        </div>

        <div className="bs-callout">
          <div className="bs-eyebrow">CLONING? CLONE INSIDE WSL</div>
          <p>
            Only relevant if you're building from source. Git on Windows converts
            line endings to CRLF by default, which breaks the shell scripts and
            container entrypoints the images run —{' '}
            <code className="bs-code-inline">exec format error</code>, or an
            entrypoint that exits instantly. Run{' '}
            <code className="bs-code-inline">git clone</code> from the WSL shell
            so the checkout stays LF.
          </p>
        </div>

        <div className="bs-callout">
          <div className="bs-eyebrow">GIVE WSL MORE MEMORY</div>
          <p>
            WSL2 takes a share of system RAM that is generous but capped, and the
            optional heavy sidecars want a lot of it (the analyzer's ceiling is{' '}
            <code className="bs-code-inline">6g</code>, tts-heavy's is{' '}
            <code className="bs-code-inline">10g</code>). Create or edit{' '}
            <code className="bs-code-inline">%UserProfile%\.wslconfig</code>, then{' '}
            <code className="bs-code-inline">wsl --shutdown</code> to apply:
          </p>
          <CodeBlock lang="ini">{`[wsl2]
memory=8GB
processors=4`}</CodeBlock>
          <p className="text-muted">
            The base station is happy in 4 GB. Only raise this if you're enabling
            heavy analysis or the voice-cloning sidecar.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">PATH B · POWERSHELL, NO WSL SHELL</p>
        <h2>Two files and docker compose.</h2>
        <p>
          Docker Desktop still uses WSL2 underneath, but you never open a Linux
          shell. This is the{' '}
          <Link href="/setup/manual" className="bs-link">Manual Install</Link>{' '}
          path with Windows spellings.
        </p>
        <CodeBlock lang="powershell">{`mkdir subwave; cd subwave
curl.exe -O https://raw.githubusercontent.com/perminder-klair/subwave/main/docker-compose.yml
curl.exe -O https://raw.githubusercontent.com/perminder-klair/subwave/main/.env.example
Rename-Item .env.example .env
notepad .env`}</CodeBlock>
        <div className="bs-callout">
          <div className="bs-eyebrow">USE CURL.EXE, NOT CURL</div>
          <p>
            In PowerShell, <code className="bs-code-inline">curl</code> is an alias
            for <code className="bs-code-inline">Invoke-WebRequest</code>, which
            doesn't understand <code className="bs-code-inline">-O</code> and will
            fail with a parameter error. The{' '}
            <code className="bs-code-inline">.exe</code> suffix calls the real
            curl that ships with Windows.
          </p>
        </div>
        <p>
          Fill in the three required keys — <code className="bs-code-inline">ADMIN_USER</code>,{' '}
          <code className="bs-code-inline">ADMIN_PASS</code>,{' '}
          <code className="bs-code-inline">SITE_URL</code> — save, then:
        </p>
        <CodeBlock lang="powershell">{`docker compose up -d
start http://localhost:7700/onboarding`}</CodeBlock>
        <p>
          The browser wizard collects your music source (Navidrome, Jellyfin, Plex or the demo library), the LLM, TTS and the DJ persona,
          exactly as <code className="bs-code-inline">subwave setup</code> would.
          From then on the stack is <code className="bs-code-inline">docker compose ps</code>,{' '}
          <code className="bs-code-inline">logs -f</code>, and{' '}
          <code className="bs-code-inline">up -d --pull always</code> to update.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WINDOWS-SPECIFIC NOTES</p>
        <h2>Worth knowing either way.</h2>
        <ul className="bs-checklist">
          <li>
            <strong>A music server on this PC isn't localhost.</strong>
            <p>
              From inside a container,{' '}
              <code className="bs-code-inline">localhost</code> is the container.
              Point the wizard at{' '}
              <code className="bs-code-inline">http://host.docker.internal:4533</code>{' '}
              (Navidrome; Jellyfin is <code className="bs-code-inline">:8096</code>, Plex{' '}
              <code className="bs-code-inline">:32400</code>) — the compose files already map that name to the host gateway. Same
              for Ollama on{' '}
              <code className="bs-code-inline">http://host.docker.internal:11434</code>.
            </p>
          </li>
          <li>
            <strong>The heavy images run native here.</strong>
            <p>
              On an x64 PC, <code className="bs-code-inline">analyzer-heavy</code>{' '}
              (CLAP + Demucs) and <code className="bs-code-inline">tts-heavy</code>{' '}
              are amd64 images on an amd64 host — no emulation penalty, unlike
              Apple Silicon. An NVIDIA card can go further still: Docker Desktop
              exposes CUDA through WSL2, so the GPU analyzer overlay works.
              Running native is not the same as running, though:{' '}
              <code className="bs-code-inline">tts-heavy</code> is profile-gated,
              so it only starts under{' '}
              <code className="bs-code-inline">docker compose --profile tts-heavy up -d</code>{' '}
              (or with <code className="bs-code-inline">COMPOSE_PROFILES=tts-heavy</code>{' '}
              in <code className="bs-code-inline">.env</code>).
            </p>
          </li>
          <li>
            <strong>Autostart is Docker Desktop's job.</strong>
            <p>
              Every service is{' '}
              <code className="bs-code-inline">restart: unless-stopped</code>, so
              tick <strong>Start Docker Desktop when you log in</strong> and the
              station returns after a reboot. Note it starts at{' '}
              <em>login</em>, not boot — a headless station box needs autologin,
              or move it to a Linux host.
            </p>
          </li>
          <li>
            <strong>Sleep kills the stream.</strong>
            <p>
              A PC that sleeps takes the station off air and drops every
              listener. If this box is the station, set the power plan to never
              sleep.
            </p>
          </li>
        </ul>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WHAT'S NEXT</p>
        <h2>Once it's on the air.</h2>
        <p>
          Everything past install is platform-neutral: the admin console at{' '}
          <code className="bs-code-inline">/admin</code> runs the station, and{' '}
          <Link href="/setup/updates" className="bs-link">Updates &amp; Help</Link>{' '}
          covers upgrades and troubleshooting. If you'd rather run this on a
          machine that never sleeps,{' '}
          <Link href="/setup/linux" className="bs-link">Linux</Link> and{' '}
          <Link href="/setup/unraid" className="bs-link">Unraid</Link> are the
          set-and-forget hosts.
        </p>
      </section>
    </SetupPage>
  );
}
