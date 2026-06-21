import Link from 'next/link';
import SetupPage from './SetupPage';
import CodeBlock from "@/components/CodeBlock";

const UNRAID_ENV_TEMPLATE = `# Required — the three boot keys
ADMIN_USER=admin
ADMIN_PASS=replace-me-with-a-strong-string   # openssl rand -hex 16
SITE_URL=http://YOUR-UNRAID-IP:7700

# Unraid-specific — keep state OFF the flash drive
STATE_DIR=/mnt/user/appdata/subwave/state
CADDY_PORT=7700
TZ=Europe/London`;

const TEMPLATE_URL =
  'https://raw.githubusercontent.com/perminder-klair/subwave/main/templates/subwave.xml';

export default function Unraid() {
  return (
    <SetupPage
      eyebrow="SETUP · UNRAID"
      title="Run it on Unraid."
      intro="Two supported paths. The easy one: install the one-click all-in-one container from Community Applications. The flexible one: run the full Compose stack via Compose Manager Plus (separate containers, BYO reverse proxy, optional heavy-TTS sidecar). Both finish in the same browser wizard. Start to on-air is about five minutes."
      current="/setup/unraid"
    >
      <section className="bs-section">
        <div className="bs-callout">
          <div className="bs-eyebrow">TWO WAYS TO RUN IT</div>
          <p>
            <strong>One-click (Community Applications)</strong> — the all-in-one
            image bundles the whole stack into a single container behind one
            port. Easiest; recommended for most people.{' '}
            <strong>Full Compose stack (Compose Manager Plus)</strong> — the
            maintained{' '}
            <code className="bs-code-inline">docker-compose.yml</code> as
            separate broadcast / controller / web / Caddy services. Pick it for
            isolated containers, your own proxy, or the heavy-TTS sidecar.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">OPTION 1 — ONE-CLICK</p>
        <h2>Community Applications.</h2>
        <p>
          The Apps catalogue is one container per template, so the{' '}
          <code className="bs-code-inline">subwave-aio</code> image bundles
          icecast2 + liquidsoap, the controller, the web UI and a Caddy edge
          together. Same images as the Compose stack — just packaged into one.
        </p>

        <div className="bs-step">
          <div className="bs-step-num">01</div>
          <div className="bs-step-body">
            <h3>Install &amp; fill the fields</h3>
            <p>
              <strong>Apps</strong> tab &rarr; search{' '}
              <strong>SUB/WAVE</strong> &rarr; <strong>Install</strong>, then set:
            </p>
            <ul className="bs-list">
              <li>
                <strong>WebUI Port</strong> — host port for the UI + stream
                (default <code className="bs-code-inline">7700</code>).
              </li>
              <li>
                <strong>Appdata</strong> —{' '}
                <code className="bs-code-inline">/mnt/user/appdata/subwave</code>,
                on the array/pool (<em>not</em> the flash).
              </li>
              <li>
                <strong>ADMIN_USER</strong> / <strong>ADMIN_PASS</strong> — your
                admin login; the password is <strong>required</strong>.
              </li>
              <li>
                <strong>SITE_URL</strong> —{' '}
                <code className="bs-code-inline">http://YOUR-UNRAID-IP:7700</code>.
              </li>
            </ul>
            <div className="bs-callout">
              <div className="bs-eyebrow">KEEP APPDATA OFF THE FLASH</div>
              <p>
                SUB/WAVE&apos;s state grows — hourly archives, the library cache,
                rendered voices. Point <strong>Appdata</strong> at{' '}
                <code className="bs-code-inline">/mnt/user/appdata/subwave</code>{' '}
                on your pool/array, never{' '}
                <code className="bs-code-inline">/boot/…</code>.
              </p>
            </div>
          </div>
        </div>

        <div className="bs-step">
          <div className="bs-step-num">02</div>
          <div className="bs-step-body">
            <h3>Finish setup in the browser</h3>
            <CodeBlock>{`open http://YOUR-UNRAID-IP:7700/onboarding`}</CodeBlock>
            <p>
              Sign in with the{' '}
              <code className="bs-code-inline">ADMIN_USER</code> /{' '}
              <code className="bs-code-inline">ADMIN_PASS</code> you set, and the
              wizard collects the rest — Navidrome, the LLM provider, TTS, the DJ
              persona. The player is at{' '}
              <code className="bs-code-inline">http://YOUR-UNRAID-IP:7700</code>.
            </p>
          </div>
        </div>

        <div className="bs-callout">
          <div className="bs-eyebrow">NOT IN THE STORE YET?</div>
          <p>
            Until the listing is approved (or to try a pre-release), add it
            directly: <strong>Docker</strong> tab &rarr;{' '}
            <strong>Add Container</strong> &rarr; paste this into{' '}
            <strong>Template URL</strong>, then fill the same fields.
          </p>
          <CodeBlock>{TEMPLATE_URL}</CodeBlock>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">OPTION 2 — FULL COMPOSE STACK</p>
        <h2>Compose Manager Plus.</h2>
        <p>
          Run the maintained{' '}
          <code className="bs-code-inline">docker-compose.yml</code> as separate
          services — good for isolated containers, your own Traefik/SWAG/NPM in
          front, or the optional Chatterbox/PocketTTS sidecar.
        </p>

        <div className="bs-step">
          <div className="bs-step-num">01</div>
          <div className="bs-step-body">
            <h3>Install Compose Manager Plus</h3>
            <p>
              On the <strong>Apps</strong> tab, search{' '}
              <code className="bs-code-inline">Compose Manager Plus</code> (by{' '}
              <code className="bs-code-inline">mstrhakr</code>) and install the
              stable release. It adds a <strong>Compose</strong> section to the{' '}
              <strong>Docker</strong> tab. You&apos;ll also want Docker enabled and
              the array (or a pool) started so there&apos;s somewhere for appdata.
            </p>
          </div>
        </div>

        <div className="bs-step">
          <div className="bs-step-num">02</div>
          <div className="bs-step-body">
            <h3>Create the stack</h3>
            <p>
              <strong>Docker</strong> tab &rarr; <strong>Compose</strong> &rarr;{' '}
              <strong>Add New Stack</strong> &rarr; name it{' '}
              <code className="bs-code-inline">subwave</code> &rarr;{' '}
              <strong>Edit Stack</strong>.
            </p>
            <ul className="bs-list">
              <li>
                <strong>Compose</strong> tab — paste the contents of the default{' '}
                <Link
                  href="https://raw.githubusercontent.com/perminder-klair/subwave/main/docker-compose.yml"
                  className="bs-link"
                >
                  docker-compose.yml
                </Link>
                . Five containers; only Caddy binds a host port (
                <code className="bs-code-inline">:7700</code>). The optional{' '}
                <code className="bs-code-inline">tts-heavy</code> sidecar is
                profile-gated and won&apos;t start — the DJ falls back to the
                built-in Piper voice.
              </li>
              <li>
                <strong>.env</strong> tab — the three required keys plus two
                Unraid-specific ones:
              </li>
            </ul>
            <CodeBlock lang="env">{UNRAID_ENV_TEMPLATE}</CodeBlock>
            <div className="bs-callout">
              <div className="bs-eyebrow">KEEP STATE OFF THE FLASH</div>
              <p>
                Compose Manager&apos;s project directory lives on the USB flash
                (<code className="bs-code-inline">/boot/…</code>), so the compose
                default of <code className="bs-code-inline">./state</code> would
                write SUB/WAVE&apos;s growing state — hourly archives, the library
                cache, rendered voices — onto the boot stick. Set{' '}
                <code className="bs-code-inline">STATE_DIR</code> to an absolute
                appdata path on your pool/array (
                <code className="bs-code-inline">/mnt/user/appdata/subwave/state</code>
                ); Docker creates it on first start.
              </p>
            </div>
          </div>
        </div>

        <div className="bs-step">
          <div className="bs-step-num">03</div>
          <div className="bs-step-body">
            <h3>Pull &amp; Up</h3>
            <p>
              From the stack&apos;s action menu pick <strong>Pull &amp; Up</strong>{' '}
              (not plain <em>Compose Up</em>), then flip the stack&apos;s{' '}
              <strong>Autostart &rarr; ON</strong> so it survives reboots.
            </p>
            <div className="bs-callout">
              <div className="bs-eyebrow">WHY PULL &amp; UP</div>
              <p>
                The compose file carries{' '}
                <code className="bs-code-inline">build:</code> blocks so a source
                checkout can rebuild locally. The Unraid project directory has no
                source, so a plain <em>up</em> would try to build and fail.{' '}
                <strong>Pull &amp; Up</strong> fetches the prebuilt images from
                GHCR first, then starts them. (Alternatively, delete the{' '}
                <code className="bs-code-inline">build:</code> blocks and plain{' '}
                <em>up</em> works too.)
              </p>
            </div>
          </div>
        </div>

        <div className="bs-step">
          <div className="bs-step-num">04</div>
          <div className="bs-step-body">
            <h3>Finish setup in the browser</h3>
            <CodeBlock>{`open http://YOUR-UNRAID-IP:7700/onboarding`}</CodeBlock>
            <p>
              Same wizard as the one-click path — Navidrome, the LLM provider,
              TTS, the DJ persona.
            </p>
          </div>
        </div>
      </section>

      <section className="bs-section">
        <div className="bs-callout">
          <div className="bs-eyebrow">THE AI DJ — OLLAMA, LOCAL OR CLOUD</div>
          <p>
            Applies to both options. SUB/WAVE ships a first-class{' '}
            <strong>&ldquo;Ollama — local/cloud&rdquo;</strong> provider. Most
            Unraid boxes lack a big GPU, so the nicest path is Ollama&apos;s{' '}
            <strong>cloud models</strong>, which offload inference — even a
            low-power box (e.g. an Intel N95) handles them fine:
          </p>
          <ul className="bs-list">
            <li>
              Install the official <code className="bs-code-inline">ollama</code>{' '}
              container from the Apps tab (defaults are right: port{' '}
              <code className="bs-code-inline">11434</code>, appdata{' '}
              <code className="bs-code-inline">/mnt/user/appdata/ollama</code>).
            </li>
            <li>
              Open its <strong>Console</strong> and run{' '}
              <code className="bs-code-inline">ollama signin</code>; approve the
              printed link in your browser (cloud models need a subscription).
            </li>
            <li>
              In <strong>admin &rarr; Settings &rarr; LLM Provider</strong>: set
              provider <strong>Ollama — local/cloud</strong>, server URL{' '}
              <code className="bs-code-inline">http://host.docker.internal:11434</code>
              , and a <code className="bs-code-inline">:cloud</code> model tag (e.g.{' '}
              <code className="bs-code-inline">glm-5.2:cloud</code>) — or a small
              local tag like{' '}
              <code className="bs-code-inline">llama3.2:3b</code> to run on CPU.
            </li>
          </ul>
        </div>
        <div className="bs-callout">
          <div className="bs-eyebrow">GOOD TO KNOW</div>
          <ul className="bs-list">
            <li>
              <strong>No reverse proxy needed</strong> for LAN use — Caddy fronts{' '}
              <code className="bs-code-inline">/</code>,{' '}
              <code className="bs-code-inline">/api</code>, and{' '}
              <code className="bs-code-inline">/stream.mp3</code> on the single
              host port. Want TLS + a hostname behind SWAG / NPM / Traefik? Front
              that port with it, or (Compose stack) use{' '}
              <code className="bs-code-inline">docker-compose.byo.yml</code>.
            </li>
            <li>
              <strong>Updates:</strong> one-click &rarr; Unraid&apos;s normal{' '}
              <strong>Check for Updates</strong>. Compose stack &rarr; stack menu
              &rarr; <strong>Pull &amp; Up</strong>.
            </li>
            <li>
              <strong>Backups:</strong> everything lives under the appdata path —
              settings, library cache, archives, voices. Back up{' '}
              <code className="bs-code-inline">/mnt/user/appdata/subwave</code>.
            </li>
          </ul>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WHAT&apos;S NEXT</p>
        <h2>Keep it running.</h2>
        <p>
          The station is on the air. When a new version lands, head to{' '}
          <Link href="/setup/updates" className="bs-link">Updates &amp; Help</Link>{' '}
          for the update workflow and the troubleshooting checklist.
        </p>
      </section>
    </SetupPage>
  );
}
