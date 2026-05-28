import Link from 'next/link';
import ManualPage from './ManualPage';

// Mirrors the SHORTCUTS list in components/ShortcutsDialog.jsx — keep the two
// in step when a binding is added or changed.
const SHORTCUTS = [
  { keys: ['Space', 'K'], action: 'Tune in / out', note: 'Starts the stream, or stops it if you are already tuned in.' },
  { keys: ['↑'], action: 'Volume up', note: 'Raises the volume in 5% steps.' },
  { keys: ['↓'], action: 'Volume down', note: 'Lowers the volume in 5% steps.' },
  { keys: ['M'], action: 'Mute / unmute', note: 'Drops to silence, then back to your last level.' },
  { keys: ['1'], action: 'Open Timeline', note: 'The upcoming queue and recent history.' },
  { keys: ['2'], action: 'Open Booth feed', note: 'What the DJ has been saying on air.' },
  { keys: ['3', 'R'], action: 'Make a request', note: 'Opens the request panel.' },
  { keys: ['4'], action: 'Open Schedule', note: 'The lineup of upcoming and recent shows.' },
  { keys: ['?'], action: 'Shortcuts help', note: 'The in-player list of every shortcut.' },
  { keys: ['⌘K', 'Ctrl K'], action: 'Command palette', note: 'A searchable menu of every player action.' },
  { keys: ['Esc'], action: 'Close', note: 'Dismisses the open drawer or dialog.' },
];

function Keys({ keys }: { keys: string[] }) {
  return (
    <span>
      {keys.map((k, i) => (
        <span key={k}>
          {i > 0 ? <span className="bs-kbd-sep">or</span> : null}
          <kbd className="bs-kbd">{k}</kbd>
        </span>
      ))}
    </span>
  );
}

export default function Shortcuts() {
  return (
    <ManualPage
      eyebrow="MANUAL · 04"
      title="Keyboard shortcuts."
      intro="The player can be driven entirely from the keyboard — tune in, change the volume, and open the panels without reaching for the mouse."
      current="/manual/shortcuts"
    >
      <section className="bs-section">
        <p className="bs-eyebrow">THE FULL LIST</p>
        <h2>Every key, and what it does.</h2>
        <p>
          These work anywhere in the player. Press <kbd className="bs-kbd">?</kbd> while
          listening to bring up the same list in a dialog, without leaving the page.
        </p>
        <table className="bs-doc-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.action}>
                <td><Keys keys={s.keys} /></td>
                <td><strong>{s.action}</strong> — {s.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">THE COMMAND PALETTE</p>
        <h2>One menu for everything.</h2>
        <p>
          Press <kbd className="bs-kbd">⌘K</kbd> (or <kbd className="bs-kbd">Ctrl K</kbd>{' '}
          on Windows and Linux) to open the <strong>command palette</strong> — a
          searchable list of every player action. Start typing to filter, use the arrow
          keys to move, and press Enter to run. It's the fastest way to reach something
          when you can't remember its key.
        </p>
        <p className="text-muted">
          The palette chord works even while you're typing in a text field, so you can
          always summon it — and press it again, or <kbd className="bs-kbd">Esc</kbd>, to
          close it.
        </p>
      </section>

      <section className="bs-section">
        <p className="bs-eyebrow">WHEN THEY'RE QUIET</p>
        <h2>Shortcuts step aside while you type.</h2>
        <p>
          The single-key shortcuts are suppressed whenever a text field is focused — so
          typing <em>R</em> into the request box writes an <em>R</em> rather than opening
          a panel. They also pause while the command palette or the shortcuts dialog is
          open, since those windows handle the keyboard themselves.
        </p>
        <div className="bs-callout">
          <div className="bs-eyebrow">REMEMBER</div>
          <p>
            There is no skip. <kbd className="bs-kbd">Space</kbd> tunes you in and out of
            the broadcast. It doesn't jump the track. See{' '}
            <Link href="/manual/getting-started" className="bs-link">Getting Started</Link>{' '}
            for why the station works that way.
          </p>
        </div>
      </section>
    </ManualPage>
  );
}
