import SetupPage from './SetupPage';
import CodeBlock from "@/components/CodeBlock";

export default function Development() {
  return (
    <SetupPage
      eyebrow="SETUP · 04"
      title="Hacking on SUB/WAVE."
      intro="Three compose files, three deployment shapes. Icecast and Liquidsoap live together in a single broadcast container in every shape. Dev mode runs the radio backend in Docker and the Next.js UI on the host with hot reload, so you can iterate on the web without a rebuild. The two prod variants differ only at the edge. One bundles Caddy, the other binds host ports for your own reverse proxy."
      current="/setup/development"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">THE THREE STACKS</p>
        <h2>Compose files.</h2>
        <table className="bs-rebuild-table mt-3">
          <thead>
            <tr>
              <th>Compose file</th>
              <th>What runs</th>
              <th>State dir</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code className="bs-code-inline">docker-compose.yml</code></td>
              <td>prod — broadcast · controller · web · caddy edge on <code className="bs-code-inline">:7700</code></td>
              <td><code className="bs-code-inline">${'{STATE_DIR:-<repo>/state}'}</code></td>
            </tr>
            <tr>
              <td><code className="bs-code-inline">docker-compose.byo.yml</code></td>
              <td>same as prod minus caddy — web, controller, broadcast on host ports{' '}
                <code className="bs-code-inline">:7700</code> /{' '}
                <code className="bs-code-inline">:7701</code> /{' '}
                <code className="bs-code-inline">:7702</code> for your own reverse proxy
              </td>
              <td><code className="bs-code-inline">${'{STATE_DIR:-<repo>/state}'}</code></td>
            </tr>
            <tr>
              <td><code className="bs-code-inline">docker-compose.dev.yml</code></td>
              <td>dev — broadcast · controller with <code className="bs-code-inline">tsx watch</code> hot-reload (web runs separately on host)</td>
              <td><code className="bs-code-inline">./state</code></td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">DAY-TO-DAY COMMANDS</p>
        <h2>Everything's an npm script.</h2>
        <p>
          The compose flags are all wired into{' '}
          <code className="bs-code-inline">package.json</code> so you don't have to remember
          them:
        </p>
        <div className="bs-cmd-list">
          <div className="bs-cmd">
            <CodeBlock>{`npm run setup`}</CodeBlock>
            <p>Interactive wizard: writes envs, brings the stack up.</p>
          </div>
          <div className="bs-cmd">
            <CodeBlock>{`npm run dev`}</CodeBlock>
            <p>Alias for setup; same wizard.</p>
          </div>
          <div className="bs-cmd">
            <CodeBlock>{`npm run dev:docker`}</CodeBlock>
            <p>
              <code className="bs-code-inline">docker compose up -d</code> — radio
              backend only.
            </p>
          </div>
          <div className="bs-cmd">
            <CodeBlock>{`npm run dev:web`}</CodeBlock>
            <p>
              <code className="bs-code-inline">next dev</code> on{' '}
              <code className="bs-code-inline">:7700</code> — hot-reloaded UI.
            </p>
          </div>
          <div className="bs-cmd">
            <CodeBlock>{`npm run rebuild`}</CodeBlock>
            <p>
              <code className="bs-code-inline">docker compose up -d --build</code> —
              rarely needed in dev, since <code className="bs-code-inline">controller/src</code>{' '}
              and <code className="bs-code-inline">radio.liq</code> are bind-mounted.
            </p>
          </div>
          <div className="bs-cmd">
            <CodeBlock>{`npm run logs`}</CodeBlock>
            <p>Tail docker logs.</p>
          </div>
          <div className="bs-cmd">
            <CodeBlock>{`npm run jingles`}</CodeBlock>
            <p>Render station idents via Piper.</p>
          </div>
          <div className="bs-cmd">
            <CodeBlock>{`npm run down`}</CodeBlock>
            <p>Stop the stack.</p>
          </div>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">A TYPICAL SESSION</p>
        <h2>Backend in Docker, UI on the host.</h2>
        <p>One-time, in two terminals:</p>
        <div className="bs-cmd-list">
          <div className="bs-cmd">
            <CodeBlock>{`npm run dev:docker`}</CodeBlock>
            <p>Terminal 1 — radio backend (broadcast + controller).</p>
          </div>
          <div className="bs-cmd">
            <CodeBlock>{`npm run dev:web`}</CodeBlock>
            <p>Terminal 2 — Next.js on http://localhost:7700.</p>
          </div>
        </div>
        <p>
          From there, edits to <code className="bs-code-inline">web/**</code> hot-reload with
          no Docker action, and <code className="bs-code-inline">controller/src/**</code>{' '}
          restarts in place under <code className="bs-code-inline">tsx watch</code>. A{' '}
          <code className="bs-code-inline">liquidsoap/radio.liq</code> change in dev needs a
          broadcast restart:
        </p>
        <CodeBlock>{`docker compose -f docker-compose.dev.yml restart broadcast`}</CodeBlock>
        <p>
          In prod, a <code className="bs-code-inline">controller/src/**</code> or{' '}
          <code className="bs-code-inline">radio.liq</code> change needs a rebuild and
          recreate (swap <code className="bs-code-inline">controller</code> for{' '}
          <code className="bs-code-inline">broadcast</code> for radio.liq changes):
        </p>
        <CodeBlock>{`docker compose up -d --build controller`}</CodeBlock>

        <div className="bs-callout">
          <div className="bs-eyebrow">DEV HOT-RELOADS · PROD NEEDS A REBUILD</div>
          <p>
            <strong>In dev,</strong> the controller container bind-mounts{' '}
            <code className="bs-code-inline">controller/src/</code> and runs under{' '}
            <code className="bs-code-inline">tsx watch</code>, so edits to{' '}
            <code className="bs-code-inline">controller/src/**</code> restart the
            process inside the container automatically.{' '}
            <code className="bs-code-inline">liquidsoap/radio.liq</code> is bind-mounted
            too; edits there need{' '}
            <code className="bs-code-inline">docker compose -f docker-compose.dev.yml restart broadcast</code>{' '}
            but no rebuild.
          </p>
          <p className="mt-2">
            <strong>In prod,</strong> both Dockerfiles{' '}
            <code className="bs-code-inline">COPY</code> source at build time, so{' '}
            <code className="bs-code-inline">docker compose restart controller</code>{' '}
            would rerun the same baked-in code.{' '}
            <code className="bs-code-inline">docker compose up -d --build &lt;service&gt;</code>{' '}
            (against <code className="bs-code-inline">docker-compose.yml</code>) is what
            you want when deploying a change.
          </p>
          <p className="mt-2 text-muted">
            The web dev server (<code className="bs-code-inline">npm run dev:web</code>) is
            its own thing: Next.js hot-reloads, so edits to{' '}
            <code className="bs-code-inline">web/**</code> show up instantly without
            touching Docker.
          </p>
        </div>
      </section>
    </SetupPage>
  );
}
