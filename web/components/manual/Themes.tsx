import Link from 'next/link';
import ManualPage from './ManualPage';
import CodeBlock from '@/components/CodeBlock';

const EXAMPLE_THEME = `{
  "id": "midnight",
  "name": "Midnight",
  "description": "Cold dark — deep navy paper, ice-blue ink.",
  "mode": "dark",
  "tokens": {
    "--bg":          "#06121f",
    "--ink":         "#cfe2ff",
    "--muted":       "#5c7896",
    "--accent":      "oklch(0.78 0.18 250)",
    "--overlay":     "rgba(0, 0, 0, 0.55)",
    "--soft-border": "rgba(207, 226, 255, 0.12)",
    "--field":       "color-mix(in oklab, #06121f 88%, #cfe2ff)"
  }
}`;

// The six faces the controller ships. Kept here so the copy below and the list
// stay in lockstep with components/skins/index.ts.
const SKINS = [
  {
    name: 'Classic',
    blurb: 'The original SUB/WAVE face — masthead, centre stage, waveform, transport deck. The default.',
  },
  {
    name: 'Spool',
    blurb: 'A walkman deck — the whole station fits on one cassette, reels turning as it plays.',
  },
  {
    name: 'Drift',
    blurb: 'Ninety percent weather, ten percent type — the cover art blooms out to fill the room.',
  },
  {
    name: 'Subamp',
    blurb: "A compact modular player — deck, booth and log stacked like it's 1998, with a live spectrum analyzer.",
  },
  {
    name: 'TTY',
    blurb: 'The station as a live process — panes and a status line, everything tailing like a terminal.',
  },
  {
    name: 'Platter',
    blurb: 'The flagship vinyl face — a reference turntable is the interface, needle tracking and all.',
  },
];

export default function Themes() {
  return (
    <ManualPage
      eyebrow="MANUAL · 09"
      title="Skins & themes."
      intro="The look of the player is two independent knobs. A skin is the whole face — the layout every listener sees. A theme is the palette that face is painted in. You set a station-wide default for each; a listener can override either in their own browser without changing what anyone else sees."
      current="/manual/themes"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">TWO LAYERS</p>
        <h2>Skin is the face. Theme is the paint.</h2>
        <p>
          They compose. Any skin can wear any theme, and swapping one never
          disturbs the other: recolour Classic to Cyberpunk and it&rsquo;s the
          same masthead-and-deck layout in cyan and hot pink; switch Classic to
          the Platter skin and the palette rides straight across to the
          turntable. Every skin reads the same live station feed &mdash;
          now-playing, the booth log, the schedule, requests &mdash; so none of
          them lose a feature; they just present it differently.
        </p>
        <p>
          Both are picked in admin &rarr;{' '}
          <Link href="/manual/admin" className="bs-link">Settings</Link> &rarr;{' '}
          <strong>Skin &amp; themes</strong>, and both propagate to every open
          player within about thirty seconds: no controller restart, no listener
          reload.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE SKINS</p>
        <h2>Six faces ship in the box.</h2>
        <p>
          Each skin is a completely different full-screen layout built on the
          same core. The station-wide pick is a contact sheet in admin
          Settings &mdash; every skin gets a live pure-CSS miniature of its real
          layout, so you can read the rack at a glance before committing. Click a
          card marked <em>Set as station skin</em> and it goes on air for
          everyone.
        </p>
        <ul className="bs-list">
          {SKINS.map((s) => (
            <li key={s.name}>
              <strong>{s.name}</strong> &mdash; {s.blurb}
            </li>
          ))}
        </ul>
        <div className="bs-callout">
          <div className="bs-eyebrow">SAME STATION, DIFFERENT ROOM</div>
          <p>
            Skins are presentation only. Every one honours the theme tokens,
            renders the same tap-to-tune-in gate (browsers can&rsquo;t autoplay,
            so the first tap is the audio-unblock gesture), and respects{' '}
            <strong>lite mode</strong> for low-power screens. Whichever face you
            choose, listeners hear the exact same broadcast in sync.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">LISTENER OVERRIDES</p>
        <h2>Anyone can pick their own look.</h2>
        <p>
          The station default is just that &mdash; a default. Every player has an{' '}
          <strong>Appearance</strong> menu (the palette icon in the header) that
          lets a listener choose a different theme <em>and</em> a different skin
          for their own browser. The choice is saved locally and beats the
          station-wide pick until they clear it; a{' '}
          <em>Use station default</em> / <em>Use station skin</em> row drops them
          back to whatever the operator is running. The same menu carries the
          per-browser lite-mode toggle.
        </p>
        <p className="text-muted">
          The skin picker only appears when the build ships more than one skin
          (it always does today). One listener&rsquo;s override never touches the
          broadcast or anyone else&rsquo;s screen &mdash; it&rsquo;s purely how{' '}
          <em>they</em> see the station.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">PICKING A THEME</p>
        <h2>The palettes.</h2>
        <p>
          The theme is set in the same admin section, each entry a card with a
          four-swatch row (paper, ink, accent, overlay) so you can read the
          palette without leaving Settings. Six ship with the box:
        </p>
        <ul className="bs-list">
          <li><strong>Classic Light</strong> &mdash; newsprint cream with hot vermilion ink. The default.</li>
          <li><strong>Classic Dark</strong> &mdash; deep charcoal newsprint with the same vermilion accent.</li>
          <li><strong>Sunset</strong> &mdash; warm dusk: plum paper, peach ink, vermilion-magenta accent.</li>
          <li><strong>Vinyl</strong> &mdash; sepia &ldquo;warm record sleeve&rdquo; with mustard accent.</li>
          <li><strong>Cyberpunk</strong> &mdash; near-black paper, cyan ink, hot pink accent.</li>
          <li><strong>Factory</strong> &mdash; industrial blueprint: warm-gray paper, charcoal ink, factory-orange accent.</li>
        </ul>
        <p className="text-muted">
          The palette recolours both the player <em>and</em> the admin console,
          so the whole install reads as one station.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">PER-SHOW OVERRIDES</p>
        <h2>A show can carry its own palette.</h2>
        <p>
          A scheduled show can opt into a different theme for its hour. Open a show in
          admin &rarr; <strong>Shows</strong>, pick one from the <em>theme override</em>{' '}
          dropdown, and the player switches to that palette while the show is on air,
          then back to the station default when the next hour starts.
        </p>
        <p>
          Leave the override on <em>Station default</em> and the show inherits the
          station-wide pick. The override is also a graceful fallback: if you delete the
          theme file out from under a show, the player silently lands back on the station
          default rather than rendering with broken tokens.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">YOUR OWN THEMES</p>
        <h2>Drop a JSON in <code className="bs-code-inline">state/themes/</code>.</h2>
        <p>
          Every theme is a single JSON file with an id, a display name, a base mode
          (<code className="bs-code-inline">light</code> or <code className="bs-code-inline">dark</code>),
          and a token map. The controller creates{' '}
          <code className="bs-code-inline">state/themes/</code> on first read and seeds it
          with a README; drop your JSONs alongside it.
        </p>
        <CodeBlock>{EXAMPLE_THEME}</CodeBlock>
        <p>
          After saving the file, hit <strong>Refresh themes</strong> in admin &rarr; Settings
          &rarr; Skin &amp; themes. That re-scans the directory, and the new entry appears in the picker.
          No mixer restart, no controller bounce.
        </p>
        <div className="bs-callout">
          <p>
            <strong>id and filename should match.</strong> A file named{' '}
            <code className="bs-code-inline">midnight.json</code> should declare{' '}
            <code className="bs-code-inline">"id": "midnight"</code>. The controller still
            loads mismatches, but a logged warning is the only hint something&rsquo;s off.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE TOKEN MAP</p>
        <h2>Seven knobs, no surprises.</h2>
        <p>
          A theme writes a fixed set of CSS variables onto <code className="bs-code-inline">&lt;html&gt;</code>.
          Any other key in your JSON is silently dropped, so a malformed theme can&rsquo;t
          inject styles or break out into other parts of the page.
        </p>
        <ul className="bs-list">
          <li><code className="bs-code-inline">--bg</code> &mdash; page background (&ldquo;paper&rdquo;).</li>
          <li><code className="bs-code-inline">--ink</code> &mdash; main text colour.</li>
          <li><code className="bs-code-inline">--muted</code> &mdash; secondary text, captions, dividers.</li>
          <li><code className="bs-code-inline">--accent</code> &mdash; the station&rsquo;s accent (active states, on-air pill, focus rings).</li>
          <li><code className="bs-code-inline">--overlay</code> &mdash; translucent wash used for hover and modal scrims.</li>
          <li><code className="bs-code-inline">--soft-border</code> &mdash; the hairline between sections.</li>
          <li><code className="bs-code-inline">--field</code> &mdash; input/textarea fill.</li>
        </ul>
        <p>
          Any CSS colour value works: hex, <code className="bs-code-inline">rgb()</code>,{' '}
          <code className="bs-code-inline">oklch()</code>,{' '}
          <code className="bs-code-inline">color-mix()</code>. <code className="bs-code-inline">mode</code>{' '}
          tells the rest of the stylesheet whether to treat the theme as light or dark;
          it controls the paper-grain blend and the few shadcn rules that still key off{' '}
          <code className="bs-code-inline">data-theme</code>. Because skins consume these
          same seven tokens, a custom theme retints every skin at once.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">UNDER THE HOOD</p>
        <h2>How the player applies it.</h2>
        <p>
          On every page load, a tiny pre-paint script reads the last-applied theme and
          skin from the browser&rsquo;s localStorage and stamps them before the first
          frame, so listeners never see the default palette or the wrong face flash
          before yours arrives. The controller serves the live theme registry at{' '}
          <code className="bs-code-inline">/api/themes</code> and the active skin id on{' '}
          <code className="bs-code-inline">/state</code>; an app-wide bootstrapper
          polls every thirty seconds and re-applies whenever either changes.
        </p>
        <p>
          The &ldquo;active&rdquo; theme is the per-show override if one is set and
          resolves, otherwise the station default; the active skin is the listener&rsquo;s
          override if set, otherwise the station default. Built-in ids are reserved &mdash;
          a user theme JSON that claims <code className="bs-code-inline">classic-light</code>{' '}
          is logged and skipped &mdash; and an unknown or removed skin id always falls back
          to Classic so the player never renders blank.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">BEYOND SKINS</p>
        <h2>Fork the reference player.</h2>
        <p>
          Skins reskin the built-in player in place. When you want to go further
          &mdash; a wholly different app, your own framework, your own everything
          &mdash; there&rsquo;s the{' '}
          <a
            href="https://github.com/getsubwave/web-player"
            className="bs-link"
            target="_blank"
            rel="noreferrer"
          >
            SUB/WAVE Web Player ↗
          </a>
          : a lean, forkable <strong>reference player</strong> in a separate
          repo, built with React + Vite + TypeScript + Tailwind. It ships pointed
          at the live public station, so it plays real radio the moment you run{' '}
          <code className="bs-code-inline">npm run dev</code> &mdash; no config
          needed.
        </p>
        <p>
          It&rsquo;s built to be cloned and redesigned. The data layer (a single
          station API client plus a handful of hooks) is cleanly separated from
          the presentation (the components), so you keep the plumbing &mdash;
          now-playing, the booth feed, up-next, requests, the schedule,
          lock-screen controls &mdash; and rebuild the look however you like.
          Point it at your own install with one environment variable:
        </p>
        <CodeBlock>{`VITE_STATION_URL=https://radio.example.com`}</CodeBlock>
        <p>
          From that one origin it derives <code className="bs-code-inline">/api</code>{' '}
          (the controller) and <code className="bs-code-inline">/stream.mp3</code>{' '}
          (the audio); it works cross-origin out of the box. Build it to a static{' '}
          <code className="bs-code-inline">dist/</code> and deploy to any host &mdash;
          Vercel, Netlify, Cloudflare, or a Docker image &mdash; in one click.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">DESCRIBE IT, DON&rsquo;T CODE IT</div>
          <p>
            The repo ships an <code className="bs-code-inline">AGENTS.md</code> and
            a built-in redesign skill, so a coding agent (Claude Code, Cursor)
            already understands how the player is wired. Tell it the vibe &mdash;
            &ldquo;warm 70s vinyl, cream and burnt orange, a serif logo&rdquo; or
            &ldquo;minimal monospace brutalist&rdquo; &mdash; and it restyles the
            player while keeping the audio and live data working. Full guide at{' '}
            <a
              href="https://getsubwave.github.io/web-player/"
              className="bs-link"
              target="_blank"
              rel="noreferrer"
            >
              getsubwave.github.io/web-player ↗
            </a>
            .
          </p>
        </div>
      </section>
    </ManualPage>
  );
}
