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
      intro="Two supported paths. The easy one: install the one-click all-in-one container from Community Applications. The flexible one: run the full Compose stack via Compose Manager Plus, which gives you separate containers, your own reverse proxy, and an optional heavy-TTS sidecar. Both finish in the same browser wizard, and start to on-air takes about five minutes."
      current="/setup/unraid"
    >
      <section className="bs-section">
        <div className="bs-callout">
          <div className="bs-eyebrow">TWO WAYS TO RUN IT</div>
          <p>
            <strong>One-click (Community Applications)</strong>: the all-in-one
            image bundles the whole stack into a single container behind one
            port. It&apos;s the easiest path, and the right one for most people.{' '}
            <strong>Full Compose stack (Compose Manager Plus)</strong>: the
            maintained{' '}
            <code className="bs-code-inline">docker-compose.yml</code> run as
            separate broadcast, controller, web, and Caddy services. Pick it if
            you want isolated containers, your own proxy, or the heavy-TTS
            sidecar.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">OPTION 1 — ONE-CLICK</p>
        <h2>Community Applications.</h2>
        <p>
          SUB/WAVE is{' '}
          <Link
            href="https://ca.unraid.net/apps/sub-wave-073qgwu0ch9rtu"
            className="bs-link"
          >
            live in Community Applications
          </Link>
          . The Apps catalogue is one container per template, so the{' '}
          <code className="bs-code-inline">subwave-aio</code> image bundles
          icecast2 + liquidsoap, the controller, the web UI, and a Caddy edge
          together. These are the same images the Compose stack uses, just
          packaged into one.
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
                <strong>WebUI Port</strong>: host port for the UI and stream
                (default <code className="bs-code-inline">7700</code>).
              </li>
              <li>
                <strong>Appdata</strong>:{' '}
                <code className="bs-code-inline">/mnt/user/appdata/subwave</code>,
                on the array or pool (<em>not</em> the flash).
              </li>
              <li>
                <strong>ADMIN_USER</strong> / <strong>ADMIN_PASS</strong>: your
                admin login. The password is <strong>required</strong>.
              </li>
              <li>
                <strong>SITE_URL</strong>:{' '}
                <code className="bs-code-inline">http://YOUR-UNRAID-IP:7700</code>.
              </li>
            </ul>
            <div className="bs-callout">
              <div className="bs-eyebrow">KEEP APPDATA OFF THE FLASH</div>
              <p>
                SUB/WAVE&apos;s state grows over time: hourly archives, the
                library cache, rendered voices. Point <strong>Appdata</strong> at{' '}
                <code className="bs-code-inline">/mnt/user/appdata/subwave</code>{' '}
                on your pool or array, never{' '}
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
              wizard collects the rest: Navidrome, the LLM provider, TTS, and the
              DJ persona. The player lives at{' '}
              <code className="bs-code-inline">http://YOUR-UNRAID-IP:7700</code>.
            </p>
          </div>
        </div>

        <div className="bs-callout">
          <div className="bs-eyebrow">PRE-RELEASE? TEMPLATE URL</div>
          <p>
            To run a build before it propagates into the Apps catalogue, say
            you&apos;re testing a new tag, add it directly: <strong>Docker</strong>{' '}
            tab &rarr; <strong>Add Container</strong> &rarr; paste this into{' '}
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
          services. It&apos;s a good fit for isolated containers, your own
          Traefik/SWAG/NPM in front, or the optional Chatterbox/PocketTTS
          sidecar.
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
              the array (or a pool) started so there&apos;s somewhere for appdata
              to live.
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
                <strong>Compose</strong> tab: paste the contents of the default{' '}
                <Link
                  href="https://raw.githubusercontent.com/perminder-klair/subwave/main/docker-compose.yml"
                  className="bs-link"
                >
                  docker-compose.yml
                </Link>
                . There are five containers, and only Caddy binds a host port (
                <code className="bs-code-inline">:7700</code>). The optional{' '}
                <code className="bs-code-inline">tts-heavy</code> sidecar is
                profile-gated and won&apos;t start, so the DJ falls back to the
                built-in Piper voice.
              </li>
              <li>
                <strong>.env</strong> tab: the three required keys plus two
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
                write SUB/WAVE&apos;s growing state (hourly archives, the library
                cache, rendered voices) onto the boot stick. Set{' '}
                <code className="bs-code-inline">STATE_DIR</code> to an absolute
                appdata path on your pool or array (
                <code className="bs-code-inline">/mnt/user/appdata/subwave/state</code>
                ), and Docker creates it on first start.
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
                source, so a plain <em>up</em> tries to build and fails.{' '}
                <strong>Pull &amp; Up</strong> fetches the prebuilt images from
                GHCR first, then starts them. If you&apos;d rather, delete the{' '}
                <code className="bs-code-inline">build:</code> blocks and plain{' '}
                <em>up</em> works too.
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
              Same wizard as the one-click path: Navidrome, the LLM provider,
              TTS, and the DJ persona.
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
            Unraid boxes don&apos;t have a big GPU, so the nicest path is
            Ollama&apos;s <strong>cloud models</strong>, which offload inference.
            Even a low-power box like an Intel N95 handles them fine:
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
              , and a <code className="bs-code-inline">:cloud</code> model tag such
              as <code className="bs-code-inline">glm-5.2:cloud</code>. Or pick a
              small local tag like{' '}
              <code className="bs-code-inline">llama3.2:3b</code> to run on CPU.
            </li>
          </ul>
        </div>
      </section>

      <section className="bs-section" id="acoustic-analysis">
        <p className="bs-eyebrow">ACOUSTIC ANALYSIS — LEAN VS HEAVY</p>
        <h2>&ldquo;Sounds-like&rdquo; and the heavy image.</h2>
        <p>
          Applies to both options. Tempo, key, intro detection, and loudness run
          out of the box, the default image analyses them in the background, so
          just run <strong>admin &rarr; Library &rarr; Rescan</strong> (tick{' '}
          <em>re-analyse</em>) and let it churn. The two <strong>heavy</strong>{' '}
          dimensions, <strong>&ldquo;sounds-like&rdquo; audio embeddings</strong>{' '}
          (CLAP) and <strong>vocal ranges</strong> (Demucs), need a CPU-torch
          stack that isn&apos;t in the lean image, so they&apos;re a separate{' '}
          <code className="bs-code-inline">-heavy</code> build (~1.9 GB,{' '}
          <strong>amd64-only</strong>). Only switch if you specifically want
          them.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">ONE-CLICK: POINT AT THE HEAVY TAG</div>
          <p>
            The heavy/lean split is baked into the all-in-one image, so you
            switch by editing the container&apos;s image, not a setting.{' '}
            <code className="bs-code-inline">ANALYZER_HEAVY</code> does{' '}
            <em>nothing</em> here; it&apos;s the split-stack toggle.
          </p>
          <ul className="bs-list">
            <li>
              <strong>Docker</strong> tab &rarr; click the{' '}
              <strong>subwave</strong> container &rarr; <strong>Edit</strong>{' '}
              (turn on <em>Advanced View</em>, top-right).
            </li>
            <li>
              Change the <strong>Repository</strong> field from{' '}
              <code className="bs-code-inline">ghcr.io/perminder-klair/subwave-aio:latest</code>{' '}
              to{' '}
              <code className="bs-code-inline">ghcr.io/perminder-klair/subwave-aio-heavy:latest</code>
              .
            </li>
            <li>
              <strong>Apply</strong> &rarr; Unraid re-pulls and recreates the
              container.
            </li>
          </ul>
          <p>
            Your state is untouched, config, personas, library tags, and the
            cached model weights all live under the appdata volume, so the swap
            is safe and reversible (edit the field back to{' '}
            <code className="bs-code-inline">subwave-aio</code> to return). First
            boot on heavy downloads the CLAP/Demucs weights, so give it a few
            minutes.
          </p>
        </div>
        <div className="bs-callout">
          <div className="bs-eyebrow">FULL COMPOSE STACK: ANALYZER_HEAVY=1</div>
          <p>
            On Option 2 the <code className="bs-code-inline">analyzer</code> is
            its own container, so flip it from the <strong>.env</strong>:
          </p>
          <CodeBlock lang="env">{`ANALYZER_HEAVY=1`}</CodeBlock>
          <p>
            <strong>Save</strong>, then <strong>Pull &amp; Up</strong>, and the{' '}
            <code className="bs-code-inline">analyzer</code> container re-pulls as{' '}
            <code className="bs-code-inline">subwave-analyzer-heavy</code>. On an
            arm64 box you&apos;d also need{' '}
            <code className="bs-code-inline">DOCKER_DEFAULT_PLATFORM=linux/amd64</code>{' '}
            (emulated).
          </p>
        </div>
      </section>

      <section className="bs-section" id="reverse-proxy">
        <p className="bs-eyebrow">BEHIND YOUR OWN PROXY</p>
        <h2>Putting it behind your reverse proxy.</h2>
        <p>
          Most Unraid boxes already run a reverse proxy, NPM / SWAG / Traefik /
          Caddy, for TLS and a tidy hostname. Putting SUB/WAVE behind yours is
          the common path, and it&apos;s a <em>single upstream</em>, not a pile
          of per-path rules. This applies to both options above.
        </p>
        <p>
          The one-click AIO image (and the Compose stack&apos;s bundled Caddy)
          already does the same-origin routing internally:{' '}
          <code className="bs-code-inline">/</code> &rarr; web UI,{' '}
          <code className="bs-code-inline">/api/*</code> &rarr; controller,{' '}
          <code className="bs-code-inline">/stream.mp3</code> &rarr; the Icecast
          stream, all on the one host port. So your front proxy points at a
          single target, with no separate backends and no per-path forwarding.
        </p>
        <CodeBlock>{`http://YOUR-UNRAID-IP:7700`}</CodeBlock>
        <p>
          Once a hostname fronts the box, set{' '}
          <code className="bs-code-inline">SITE_URL</code> to the public{' '}
          <code className="bs-code-inline">https://</code> address, not the{' '}
          <code className="bs-code-inline">IP:port</code>. It backs share cards
          and absolute links, so it has to be the address listeners actually
          use. TLS terminates at your proxy; SUB/WAVE speaks plain HTTP behind
          it, exactly as the bundled Caddy does behind Cloudflare in the
          reference setup.
        </p>
        <CodeBlock lang="env">{`SITE_URL=https://radio.example.com`}</CodeBlock>
        <div className="bs-callout">
          <div className="bs-eyebrow">THE ONE GOTCHA: DON&apos;T BUFFER THE STREAM</div>
          <p>
            Turn response buffering <strong>off</strong> for{' '}
            <code className="bs-code-inline">/stream.mp3</code>. The bundled
            Caddy serves the stream unbuffered (
            <code className="bs-code-inline">flush_interval -1</code>). A front
            proxy that buffers, and <strong>NPM buffers by default</strong>,
            holds the live audio back: latency and stutter, or stalled playback
            outright. Exempt the stream path and leave everything else on the
            proxy&apos;s normal settings.
          </p>
          <p>
            <strong>Nginx Proxy Manager</strong>: open the proxy host &rarr;{' '}
            <strong>Advanced</strong> tab and add a location block for the
            stream. The rest of the site keeps NPM&apos;s normal proxying from
            the main tab.
          </p>
          <CodeBlock lang="nginx">{`location /stream.mp3 {
    proxy_pass http://YOUR-UNRAID-IP:7700;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;   # the stream never ends, don't time it out
}`}</CodeBlock>
          <p>The same one knob in the other proxies:</p>
          <ul className="bs-list">
            <li>
              <strong>raw nginx</strong>:{' '}
              <code className="bs-code-inline">proxy_buffering off;</code> plus a
              long <code className="bs-code-inline">proxy_read_timeout</code> in a{' '}
              <code className="bs-code-inline">location /stream.mp3</code> block.
            </li>
            <li>
              <strong>Caddy</strong>:{' '}
              <code className="bs-code-inline">{'reverse_proxy … { flush_interval -1 }'}</code>{' '}
              on the stream path.
            </li>
            <li>
              <strong>Traefik</strong>: nothing, it doesn&apos;t buffer responses
              by default.
            </li>
          </ul>
        </div>
        <div className="bs-callout">
          <div className="bs-eyebrow">PREFER TO DROP THE BUNDLED CADDY?</div>
          <p>
            If you&apos;d rather your proxy talk to each service directly, run
            the split-container stack (Option 2) with{' '}
            <code className="bs-code-inline">docker-compose.byo.yml</code>. There{' '}
            <code className="bs-code-inline">web</code> /{' '}
            <code className="bs-code-inline">controller</code> /{' '}
            <code className="bs-code-inline">broadcast</code> bind host ports
            themselves (<code className="bs-code-inline">7700</code> /{' '}
            <code className="bs-code-inline">7701</code> /{' '}
            <code className="bs-code-inline">7702</code>), but the web image is
            still baked for same-origin{' '}
            <code className="bs-code-inline">/api</code> +{' '}
            <code className="bs-code-inline">/stream.mp3</code>, so your proxy
            then has to replicate the whole route table on one hostname.
            That&apos;s more proxy config, not less, and only worth it if you
            specifically want the bundled Caddy out of the path. For most people
            the single-upstream setup above is the easier win.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <div className="bs-callout">
          <div className="bs-eyebrow">GOOD TO KNOW</div>
          <ul className="bs-list">
            <li>
              <strong>No reverse proxy needed</strong> for LAN use. Caddy fronts{' '}
              <code className="bs-code-inline">/</code>,{' '}
              <code className="bs-code-inline">/api</code>, and{' '}
              <code className="bs-code-inline">/stream.mp3</code> on the single
              host port. Want TLS and a hostname behind SWAG / NPM / Traefik? See{' '}
              <Link href="#reverse-proxy" className="bs-link">
                Putting it behind your reverse proxy
              </Link>{' '}
              above: one upstream, plus the one stream-buffering gotcha.
            </li>
            <li>
              <strong>Updates:</strong> for one-click, use Unraid&apos;s normal{' '}
              <strong>Check for Updates</strong>. For the Compose stack, open the
              stack menu &rarr; <strong>Pull &amp; Up</strong>.
            </li>
            <li>
              <strong>Backups:</strong> everything lives under the appdata path,
              settings, library cache, archives, and voices included. Back up{' '}
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
          for the update workflow and a troubleshooting checklist.
        </p>
      </section>
    </SetupPage>
  );
}
