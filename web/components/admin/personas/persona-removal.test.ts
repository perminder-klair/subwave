// #1950: removing the persona whose editor is open took the whole panel down
// with "Cannot read properties of undefined (reading 'trim')".
//
// EditorDialog wraps its body in motion's AnimatePresence, which keeps a closing
// editor's element tree mounted, frozen with its OLD props, for the exit
// animation. After a removal those frozen controllers were still bound to
// `personas.<removed index>.*`. RHF's post-replace broadcast re-rendered them,
// `register()` re-created the path from `_defaultValues`, and a half-row
// (tags, the behaviour dials, skills; no `id`, no `name`) reappeared in
// `watch('personas')`, where the first `p.name.trim()` threw. It took the
// persona in the LAST form-array slot, i.e. the most recently added one.
//
// The fix keys the editor by the focused persona's id, as ShowsPanel already
// keys ShowEditor: removing the focused row always changes that id, so React
// unmounts the frozen tree in the same commit as the removal.
//
// WHAT THIS FILE PROVES, PRECISELY
// --------------------------------
// `web/` has no DOM test environment, so the first test does NOT render the
// panel. It parses PersonasPanel.tsx and pins the key structurally, the same
// posture as tts/CloudProviderSelector.test.tsx. The crash itself was reproduced,
// and the fix confirmed, by mounting the real panel in a throwaway jsdom harness;
// that harness is not committed because it needs a DOM dependency web/ does not
// carry. The remaining tests cover the removal-impact warning, which is pure.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { personaRemovalImpact } from './helpers';
import type { SettingsResponse } from './types';

const panelPath = join(process.cwd(), 'components/admin/PersonasPanel.tsx');
const sf = ts.createSourceFile(
  'PersonasPanel.tsx', readFileSync(panelPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
);

// Both JSX kinds, because the call site is self-closing today and an opening
// element tomorrow would otherwise read as "no editor rendered".
function editorElements(): Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> {
  const found: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && node.tagName.getText(sf) === 'PersonaEditor') {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function attrExpression(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string): string | null {
  const attr = el.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === name,
  );
  const init = attr?.initializer;
  if (!init || !ts.isJsxExpression(init) || !init.expression) return null;
  return init.expression.getText(sf);
}

test('the persona editor is keyed by the id of the persona it edits (#1950)', () => {
  const editors = editorElements();
  assert.equal(editors.length, 1, 'PersonasPanel must render exactly one PersonaEditor');
  const editor = editors[0]!;
  const persona = attrExpression(editor, 'persona');
  assert.ok(persona, 'the editor must be handed its persona as an expression');
  // Not just "has a key": an index key would survive a removal that shifts the
  // next persona into the same slot, and a key naming some other value could
  // stay put while the edited persona changes underneath it.
  assert.equal(
    attrExpression(editor, 'key'),
    `${persona}.id`,
    'PersonaEditor must be keyed by the id of the persona it is given, so removing that persona unmounts the closing editor instead of leaving its controllers bound to a dead index',
  );
});

const settings = (shows: unknown): SettingsResponse =>
  ({ values: { shows } } as unknown as SettingsResponse);

test('removal impact names the shows a persona hosts and guests on', () => {
  const impact = personaRemovalImpact('p_host', settings([
    { id: 's1', name: 'Late Night', personaId: 'p_host', guestPersonaIds: [] },
    { id: 's2', name: '  Breakfast  ', personaId: 'p_host' },
    { id: 's3', name: 'Drive', personaId: 'p_other', guestPersonaIds: ['p_host'] },
    { id: 's4', name: 'Unrelated', personaId: 'p_other', guestPersonaIds: ['p_third'] },
  ]));
  assert.deepEqual(impact, { hosts: ['Late Night', 'Breakfast'], guestOn: ['Drive'], endsTakeoverOf: null });
});

test('a host listed among its own guests is reported once, as the host', () => {
  // Defence in depth: the controller's load path already strips a host from
  // its own guests (repairShowForLoad), so GET /settings should never send this
  // shape. If it did, the show is deleted, not merely left.
  const impact = personaRemovalImpact('p_host', settings([
    { id: 's1', name: 'Solo', personaId: 'p_host', guestPersonaIds: ['p_host'] },
  ]));
  assert.deepEqual(impact, { hosts: ['Solo'], guestOn: [], endsTakeoverOf: null });
});

test('an unnamed show still gets a label', () => {
  const impact = personaRemovalImpact('p_host', settings([
    { id: 's1', name: '   ', personaId: 'p_host' },
    { id: 's2', personaId: 'p_host' },
  ]));
  assert.deepEqual(impact.hosts, ['Untitled show', 'Untitled show']);
});

test('no shows, no payload, or a malformed list means no impact', () => {
  // A never-saved persona, an older controller, or settings still loading must
  // not invent a warning.
  const none = { hosts: [], guestOn: [], endsTakeoverOf: null };
  assert.deepEqual(personaRemovalImpact('p_host', null), none);
  assert.deepEqual(personaRemovalImpact('p_host', {} as SettingsResponse), none);
  assert.deepEqual(personaRemovalImpact('p_host', settings('not-an-array')), none);
  assert.deepEqual(personaRemovalImpact('p_new', settings([
    { id: 's1', name: 'Late Night', personaId: 'p_host', guestPersonaIds: ['p_other'] },
  ])), none);
});

// The takeover line: the controller's sweep clears a takeover whose pinned show
// it just deleted, so the confirm says so, but only when one is really running.
const NOW = Date.UTC(2026, 9, 16, 21, 0);
const hosting = settings([
  { id: 's_late', name: 'Late Night', personaId: 'p_host' },
  { id: 's_drive', name: 'Drive', personaId: 'p_other', guestPersonaIds: ['p_host'] },
]);
const live = (override: { showId: string | null; expiresAt: number } | null) => ({ override, now: NOW });

test('a live takeover pinning a show the persona hosts is reported as ending', () => {
  const impact = personaRemovalImpact('p_host', hosting, live({ showId: 's_late', expiresAt: NOW + 60_000 }));
  assert.equal(impact.endsTakeoverOf, 'Late Night');
});

test('a takeover that the delete leaves alone is not mentioned', () => {
  // Pinning a show the persona only GUESTS on: the show survives, so does the pin.
  assert.equal(personaRemovalImpact('p_host', hosting, live({ showId: 's_drive', expiresAt: NOW + 60_000 })).endsTakeoverOf, null);
  // Default programming pins no show at all (#1507).
  assert.equal(personaRemovalImpact('p_host', hosting, live({ showId: null, expiresAt: NOW + 60_000 })).endsTakeoverOf, null);
  // No takeover, or the caller never asked.
  assert.equal(personaRemovalImpact('p_host', hosting, live(null)).endsTakeoverOf, null);
  assert.equal(personaRemovalImpact('p_host', hosting).endsTakeoverOf, null);
});

test('a takeover that has already run out is not reported as cancelled', () => {
  // GET /schedule nulls an expired pin, but the cached read can outlive it.
  // Expiry is exclusive, the same as the controller's getScheduleOverride.
  assert.equal(personaRemovalImpact('p_host', hosting, live({ showId: 's_late', expiresAt: NOW })).endsTakeoverOf, null);
  assert.equal(personaRemovalImpact('p_host', hosting, live({ showId: 's_late', expiresAt: NOW - 1 })).endsTakeoverOf, null);
});
