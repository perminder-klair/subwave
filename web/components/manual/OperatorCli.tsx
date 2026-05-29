import Link from 'next/link';
import ManualPage from './ManualPage';
import CodeBlock from "@/components/CodeBlock";

export default function OperatorCli() {
  return (
    <ManualPage
      eyebrow="MANUAL · 09"
      title="The operator console."
      intro="SUB/WAVE ships a command-line console for running the station. One command opens a menu that boots the stack, checks its health, tails logs, and opens a terminal player — no Docker flags to remember."
      current="/manual/cli"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">PRESS START</p>
        <h2>One command opens the console.</h2>
        <p>
          From a SUB/WAVE checkout, run <code className="bs-code-inline">npm start</code>. The
          console is a menu: arrow keys to move, Enter to choose, Esc to step back, Ctrl-C to
          quit.
        </p>
        <CodeBlock>{`npm start`}</CodeBlock>
        <p className="text-muted">
          First time through? If there&rsquo;s no{' '}
          <code className="bs-code-inline">.env</code> yet, the console drops you
          straight into the install wizard — the same one the{' '}
          <Link href="/setup" className="bs-link">setup guide</Link> walks through.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WHAT THE MENU OFFERS</p>
        <h2>Everything you need to run the station.</h2>
        <p>
          The menu adapts to what&rsquo;s running. When the stack is down you only see{' '}
          <strong>start</strong>; when it&rsquo;s up, the running-stack actions take its
          place.
        </p>
        <ul className="bs-list">
          <li>
            <strong>status</strong> — a quick snapshot: which stack is up, how many containers
            are running, and what&rsquo;s on the air right now.
          </li>
          <li>
            <strong>doctor</strong> — a full diagnostic sweep: the Docker daemon, every
            container, the controller&rsquo;s HTTP health, Navidrome reachability, and recent
            errors in the logs.
          </li>
          <li>
            <strong>start / stop</strong> — bring the stack up or down. Starting from cold
            asks whether you want the dev or production layout.
          </li>
          <li>
            <strong>restart</strong> — rebuild and recreate a single service. The console
            knows the controller and Liquidsoap need a rebuild — not a plain restart — for
            source changes to take.
          </li>
          <li>
            <strong>logs</strong> — tail one service, or all of them, without the long{' '}
            <code className="bs-code-inline">docker compose -f …</code> incantation.
          </li>
          <li>
            <strong>play</strong> — open the terminal player (below).
          </li>
          <li>
            <strong>listen</strong> — open the web player in your browser.
          </li>
          <li>
            <strong>admin</strong> — open the admin console in your browser.
          </li>
          <li>
            <strong>setup</strong> — re-run the install wizard.
          </li>
        </ul>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">HEALTH AT A GLANCE</p>
        <h2>Status for a glance, doctor for a deploy.</h2>
        <p>
          <strong>status</strong> is the two-second &ldquo;is it on the air?&rdquo; check.{' '}
          <strong>doctor</strong> is the deeper sweep. Run it after a deploy, or when
          something looks off. It&rsquo;s the console&rsquo;s equivalent of{' '}
          <code className="bs-code-inline">scripts/health-check.sh</code>, and it ends with an
          ok / warn / fail tally plus a hint at the first thing that&rsquo;s unhappy.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">PLAYER &amp; CONSOLES</p>
        <h2>Jump straight to the player or the admin.</h2>
        <p>
          The <strong>play</strong> option launches the SUB/WAVE TUI — now-playing, the
          timeline, the live booth feed, and a request form, all in your terminal and pointed
          at your own stack. It&rsquo;s the full station experience without a browser. The{' '}
          <Link href="/manual/clients" className="bs-link">Listen With</Link> page covers the
          TUI in detail.
        </p>
        <p>
          Prefer the browser? <strong>listen</strong> and <strong>admin</strong> open the web
          player and the admin console in your default browser, pointed at the same stack — no
          host or port to remember.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">SCRIPTING IT</p>
        <h2>Every action runs without the menu too.</h2>
        <p>
          The menu is for hands-on operating. To skip it — for a deploy script, a cron job, or
          just speed — append the action after <code className="bs-code-inline">npm start
          --</code>:
        </p>
        <CodeBlock>{`npm start -- status        # print a snapshot, then exit
npm start -- doctor        # run the full sweep, then exit
npm start -- logs controller
npm start -- restart controller`}</CodeBlock>
        <p className="text-muted">
          Same actions, same output — just without the interactive menu wrapped around them.
        </p>
      </section>
    </ManualPage>
  );
}
