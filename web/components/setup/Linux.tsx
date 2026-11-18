import Link from 'next/link';
import SetupPage from './SetupPage';
import CodeBlock from "@/components/CodeBlock";

export default function Linux() {
  return (
    <SetupPage
      eyebrow="SETUP · LINUX"
      title="Run it on Linux."
      meta="Debian · Ubuntu · Fedora · Arch · any x86-64 or arm64 box"
      intro="Linux is where SUB/WAVE is meant to live: everything runs native, one host port is exposed, and the restart policy brings the station back after a reboot with no unit file to write. This page is the Quick Start plus the host-side details — Docker Engine, the firewall, SELinux, and where the state directory should sit."
      current="/setup/linux"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">STEP BY STEP</p>
        <h2>Four commands to on-air.</h2>

        <div className="bs-step">
          <div className="bs-step-num">01</div>
          <div className="bs-step-body">
            <h3>Install Docker Engine</h3>
            <p>
              Use Docker's own convenience script or your distro's official
              Docker repo — <em>not</em> the packaged{' '}
              <code className="bs-code-inline">docker.io</code> +{' '}
              <code className="bs-code-inline">docker-compose</code> pair on older
              releases. SUB/WAVE needs Compose v2 (the space-separated{' '}
              <code className="bs-code-inline">docker compose</code>) and Docker
              20.10+ for the <code className="bs-code-inline">host-gateway</code>{' '}
              mapping the containers use to reach services on the host.
            </p>
            <CodeBlock>{`curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
newgrp docker`}</CodeBlock>
            <p className="text-muted">
              The group change takes effect on your next login;{' '}
              <code className="bs-code-inline">newgrp docker</code> applies it to
              the current shell. Verify with{' '}
              <code className="bs-code-inline">docker compose version</code>.
            </p>
          </div>
        </div>

        <div className="bs-step">
          <div className="bs-step-num">02</div>
          <div className="bs-step-body">
            <h3>Install the CLI</h3>
            <p>
              The installer detects{' '}
              <code className="bs-code-inline">linux-x64</code> or{' '}
              <code className="bs-code-inline">linux-arm64</code>, verifies the
              published SHA256, and installs to{' '}
              <code className="bs-code-inline">/usr/local/bin</code> (elevating
              with sudo if it isn't writable).
            </p>
            <CodeBlock>{`curl -fsSL https://cli.getsubwave.com | sh`}</CodeBlock>
            <p className="text-muted">
              No root on this box? Install to a user path instead and make sure
              it's on your PATH:{' '}
              <code className="bs-code-inline">curl -fsSL https://cli.getsubwave.com | sh -s -- --dir ~/.local/bin</code>
            </p>
          </div>
        </div>

        <div className="bs-step">
          <div className="bs-step-num">03</div>
          <div className="bs-step-body">
            <h3>Scaffold and configure</h3>
            <p>
              The installer offers to run{' '}
              <code className="bs-code-inline">init</code> for you (install dir,
              deployment shape, admin credentials, then brings the stack up).
              Afterwards:
            </p>
            <CodeBlock>{`subwave setup`}</CodeBlock>
            <p>
              Navidrome, the LLM, TTS and the DJ persona, then jingle rendering.
              If your reverse proxy already fronts this host, choose{' '}
              <strong>prod-byo</strong> at init time — that's the compose shape
              without the bundled Caddy, described on{' '}
              <Link href="/setup/manual" className="bs-link">Manual Install</Link>.
            </p>
          </div>
        </div>

        <div className="bs-step">
          <div className="bs-step-num">04</div>
          <div className="bs-step-body">
            <h3>Open the port, tune in</h3>
            <p>
              The default stack binds exactly one host port —{' '}
              <code className="bs-code-inline">7700</code>, Caddy. Let it through
              whichever firewall you run. Debian and Ubuntu:
            </p>
            <CodeBlock>{`sudo ufw allow 7700/tcp`}</CodeBlock>
            <p>Fedora and RHEL:</p>
            <CodeBlock>{`sudo firewall-cmd --add-port=7700/tcp --permanent && sudo firewall-cmd --reload`}</CodeBlock>
            <p>
              Then <code className="bs-code-inline">http://SERVER-IP:7700</code>.
              If a Cloudflare Tunnel or a reverse proxy on this same host is the
              only way in, choose <strong>prod-byo</strong> at init time and set{' '}
              <code className="bs-code-inline">BIND_ADDRESS=127.0.0.1</code> in{' '}
              <code className="bs-code-inline">.env</code> — that shape publishes
              each service on its own host port and honours the override. The
              default stack ignores{' '}
              <code className="bs-code-inline">BIND_ADDRESS</code> entirely: its
              Caddy port is published on every interface, and Docker publishes
              past <code className="bs-code-inline">ufw</code>, so simply
              skipping the rule above does not close it.
            </p>
            <CodeBlock>{`subwave doctor`}</CodeBlock>
          </div>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">HOST-SIDE DETAILS</p>
        <h2>The things that bite on a server.</h2>

        <div className="bs-callout">
          <div className="bs-eyebrow">SELINUX: LABEL THE STATE DIR</div>
          <p>
            On Fedora, RHEL, Rocky and friends running SELinux in enforcing mode,
            the <code className="bs-code-inline">state/</code> bind mount is
            blocked no matter what the Unix permissions say. The symptom is a
            controller that boots and then can't write to{' '}
            <code className="bs-code-inline">/var/sub-wave</code>. Relabel it once:
          </p>
          <CodeBlock>{`sudo chcon -Rt container_file_t ~/subwave/state`}</CodeBlock>
        </div>

        <div className="bs-callout">
          <div className="bs-eyebrow">KEEP STATE ON LOCAL DISK</div>
          <p>
            <code className="bs-code-inline">state/library.db</code> is SQLite in
            WAL mode, and WAL wants real POSIX locking. An NFS or SMB mount gives
            you corruption and &ldquo;database is locked&rdquo; errors under load.
            Point <code className="bs-code-inline">STATE_DIR</code> at local
            storage; the music library itself can live anywhere, since SUB/WAVE
            reaches it over the Subsonic API rather than the filesystem.
          </p>
        </div>

        <div className="bs-callout">
          <div className="bs-eyebrow">REBOOTS NEED NO SYSTEMD UNIT</div>
          <p>
            Every service is{' '}
            <code className="bs-code-inline">restart: unless-stopped</code>, so
            the station comes back with the Docker daemon. All you need is:
          </p>
          <CodeBlock>{`sudo systemctl enable docker`}</CodeBlock>
          <p className="text-muted">
            Set <code className="bs-code-inline">TZ</code> in{' '}
            <code className="bs-code-inline">.env</code> too (e.g.{' '}
            <code className="bs-code-inline">TZ=Europe/London</code>) — schedule
            slots fire on the container's clock, which is UTC otherwise.
          </p>
        </div>

        <div className="bs-callout">
          <div className="bs-eyebrow">ROOTLESS DOCKER: ONE PANEL BREAKS</div>
          <p>
            The stack runs rootless, but the admin <strong>Stats</strong> panel
            reads container metrics through a locked-down socket proxy that
            mounts <code className="bs-code-inline">/var/run/docker.sock</code>.
            Under rootless Docker the socket lives at{' '}
            <code className="bs-code-inline">$XDG_RUNTIME_DIR/docker.sock</code>{' '}
            instead — either repoint that volume in{' '}
            <code className="bs-code-inline">docker-compose.yml</code>, or drop
            the <code className="bs-code-inline">docker-socket-proxy</code>{' '}
            service and the controller's{' '}
            <code className="bs-code-inline">DOCKER_HOST</code> line. Everything
            else is unaffected.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">SIZING</p>
        <h2>What the box needs.</h2>
        <ul className="bs-list">
          <li>
            <strong>~2 GB RAM</strong> — broadcast, controller, web and Caddy.
            Comfortably a small VPS or an old NUC.
          </li>
          <li>
            <strong>+1 GB</strong> — the default lean analyzer (bpm, key,
            loudness, outro). Its ceiling is{' '}
            <code className="bs-code-inline">ANALYZER_MEM_LIMIT</code>, default{' '}
            <code className="bs-code-inline">6g</code>; lower it on a constrained
            host.
          </li>
          <li>
            <strong>8 GB+</strong> — only if you opt into{' '}
            <code className="bs-code-inline">ANALYZER_HEAVY=1</code> (CLAP +
            Demucs) or the <code className="bs-code-inline">tts-heavy</code>{' '}
            voice-cloning sidecar. Note the two opt in differently: the analyzer
            already runs and{' '}
            <code className="bs-code-inline">ANALYZER_HEAVY=1</code> only swaps
            its image, while <code className="bs-code-inline">tts-heavy</code> is
            profile-gated and does not start at all until you run{' '}
            <code className="bs-code-inline">docker compose --profile tts-heavy up -d</code>{' '}
            (or set <code className="bs-code-inline">COMPOSE_PROFILES=tts-heavy</code>{' '}
            in <code className="bs-code-inline">.env</code>).
          </li>
          <li>
            <strong>NVIDIA card?</strong> The heavy analysis stack has a CUDA
            flavour — layer{' '}
            <code className="bs-code-inline">docker-compose.analyzer-gpu.yml</code>{' '}
            over the default compose file. On a card older than an RTX 20-series,
            also set <code className="bs-code-inline">ANALYZER_CUDA_TAG=pascal</code>{' '}
            (or your card&rsquo;s architecture) in{' '}
            <code className="bs-code-inline">.env</code>.
          </li>
        </ul>
        <div className="bs-callout">
          <div className="bs-eyebrow">RASPBERRY PI AND OTHER ARM BOXES</div>
          <p>
            Broadcast, controller, web, Caddy and the lean analyzer are all
            published multi-arch, so they run native on arm64 — a Pi 4/5 hosts a
            station fine. The heavy analyzer and{' '}
            <code className="bs-code-inline">tts-heavy</code> are amd64-only and
            emulating PyTorch on a Pi isn't worth it: keep analysis lean and use
            a cloud LLM, or Piper and Kokoro for voice (both ship inside the
            controller image and run on CPU).
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">DAY TO DAY</p>
        <h2>Running the station.</h2>
        <div className="bs-cmd-list">
          <div className="bs-cmd">
            <CodeBlock>{`subwave status`}</CodeBlock>
            <p>Stack + now-playing snapshot.</p>
          </div>
          <div className="bs-cmd">
            <CodeBlock>{`subwave logs broadcast`}</CodeBlock>
            <p>Tail one service, or all of them.</p>
          </div>
          <div className="bs-cmd">
            <CodeBlock>{`subwave update`}</CodeBlock>
            <p>Pull new images, recreate only what changed.</p>
          </div>
          <div className="bs-cmd">
            <CodeBlock>{`subwave restart controller`}</CodeBlock>
            <p>Bounce a single service.</p>
          </div>
        </div>
        <p>
          Prefer plain compose on a server you manage with Ansible or similar?{' '}
          <Link href="/setup/manual" className="bs-link">Manual Install</Link>{' '}
          uses the same images and the same{' '}
          <code className="bs-code-inline">state/</code> layout, so you can move
          between the two.{' '}
          <Link href="/setup/updates" className="bs-link">Updates &amp; Help</Link>{' '}
          covers upgrades and the troubleshooting checklist.
        </p>
      </section>
    </SetupPage>
  );
}
