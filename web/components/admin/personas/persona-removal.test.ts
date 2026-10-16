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
// carry.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

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
