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

export default function Themes() {
  return (
    <ManualPage
      eyebrow="MANUAL · 09"
      title="Themes."
      intro="SUB/WAVE renders the player and the admin console through one shared palette. You pick the station's theme; everyone listening sees the same look. Built-ins ship with the controller, and you can drop your own JSONs in to extend the menu."
      current="/manual/themes"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">PICKING A THEME</p>
        <h2>One picker, every surface.</h2>
        <p>
          The station's theme lives in admin → <Link href="/manual/admin" className="bs-link">Settings</Link> →{' '}
          <strong>Theme</strong>. Each entry is a card with a four-swatch row (paper, ink,
          accent, overlay) so you can read the palette without leaving Settings. Click a
          card and the change applies immediately for you, then propagates to every open
          player within about thirty seconds: no controller restart, no listener reload.
        </p>
        <p>
          Five palettes ship with the box:
        </p>
        <ul className="bs-list">
          <li><strong>Classic Light</strong> — newsprint cream with hot vermilion ink. The default.</li>
          <li><strong>Classic Dark</strong> — deep charcoal newsprint with the same vermilion accent.</li>
          <li><strong>Sunset</strong> — warm dusk: plum paper, peach ink, vermilion-magenta accent.</li>
          <li><strong>Vinyl</strong> — sepia "warm record sleeve" with mustard accent.</li>
          <li><strong>Cyberpunk</strong> — near-black paper, cyan ink, hot pink accent.</li>
        </ul>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">PER-SHOW OVERRIDES</p>
        <h2>A show can carry its own palette.</h2>
        <p>
          A scheduled show can opt into a different theme for its hour. Open a show in
          admin → <strong>Shows</strong>, pick one from the <em>theme override</em>{' '}
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
          After saving the file, hit <strong>Refresh themes</strong> in admin → Settings
          → Theme. That re-scans the directory, and the new entry appears in the picker.
          No mixer restart, no controller bounce.
        </p>
        <div className="bs-callout">
          <p>
            <strong>id and filename should match.</strong> A file named{' '}
            <code className="bs-code-inline">midnight.json</code> should declare{' '}
            <code className="bs-code-inline">"id": "midnight"</code>. The controller still
            loads mismatches, but a logged warning is the only hint something's off.
          </p>
        </div>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE TOKEN MAP</p>
        <h2>Seven knobs, no surprises.</h2>
        <p>
          A theme writes a fixed set of CSS variables onto <code className="bs-code-inline">&lt;html&gt;</code>.
          Any other key in your JSON is silently dropped, so a malformed theme can't
          inject styles or break out into other parts of the page.
        </p>
        <ul className="bs-list">
          <li><code className="bs-code-inline">--bg</code> — page background ("paper").</li>
          <li><code className="bs-code-inline">--ink</code> — main text colour.</li>
          <li><code className="bs-code-inline">--muted</code> — secondary text, captions, dividers.</li>
          <li><code className="bs-code-inline">--accent</code> — the station's accent (active states, on-air pill, focus rings).</li>
          <li><code className="bs-code-inline">--overlay</code> — translucent wash used for hover and modal scrims.</li>
          <li><code className="bs-code-inline">--soft-border</code> — the hairline between sections.</li>
          <li><code className="bs-code-inline">--field</code> — input/textarea fill.</li>
        </ul>
        <p>
          Any CSS colour value works: hex, <code className="bs-code-inline">rgb()</code>,{' '}
          <code className="bs-code-inline">oklch()</code>,{' '}
          <code className="bs-code-inline">color-mix()</code>. <code className="bs-code-inline">mode</code>{' '}
          tells the rest of the stylesheet whether to treat the theme as light or dark;
          it controls the paper-grain blend and the few shadcn rules that still key off{' '}
          <code className="bs-code-inline">data-theme</code>.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">UNDER THE HOOD</p>
        <h2>How the player applies it.</h2>
        <p>
          On every page load, a tiny pre-paint script reads the last-applied theme from
          the browser's localStorage and writes the seven variables onto{' '}
          <code className="bs-code-inline">&lt;html&gt;</code> before the first frame, so
          listeners never see the default palette flash before yours arrives. The
          controller serves the live registry at{' '}
          <code className="bs-code-inline">/api/themes</code>; an app-wide bootstrapper
          polls it every thirty seconds and re-applies whenever the active id changes.
        </p>
        <p>
          The "active id" is the per-show override if one is set and resolves, otherwise
          the station default. Built-in ids are reserved. A user JSON that claims{' '}
          <code className="bs-code-inline">classic-light</code> is logged and skipped.
        </p>
      </section>
    </ManualPage>
  );
}
