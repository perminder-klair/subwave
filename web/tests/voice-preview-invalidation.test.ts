import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  resolve(here, '..', 'components', 'admin', 'tts', 'VoicePreviewButton.tsx'),
  'utf8',
);

// `VoicePreviewButton` keeps a rendered sample alive so it can be replayed, and
// discards it when the props that shape the audio change. That invalidation is a
// SECOND, hand-maintained list of the same props — and it had drifted.
//
// `text`, `corrections` and `voiceSettings` all reach `fetchPreviewSample` and
// none of them were listed. Editing the sample text therefore left the previous
// audio playing underneath the new label: a stale sample the player had no way to
// know was stale, which is the exact case the effect exists to prevent.
//
// This compares the two lists by AST rather than by review, because the failure
// is semantic — a prop can reach the request through one expression and the effect
// through a different one (`corrections` becomes `correctionsKey`,
// `voiceSettings` becomes four scalar reads), and only the compiler knows that.

// Props that legitimately do not invalidate. `adminFetch` is plumbing and `signal`
// is per-request; neither is part of a sample's identity.
const NOT_SAMPLE_IDENTITY = new Set(['adminFetch', 'signal']);

function sourceFile(source = SRC): ts.SourceFile {
  return ts.createSourceFile(
    'VoicePreviewButton.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
  );
}

/** Every prop name the render request actually sends. */
function requestProps(): string[] {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'fetchPreviewSample') {
      const payload = node.arguments[1];
      if (payload && ts.isObjectLiteralExpression(payload)) {
        for (const prop of payload.properties) {
          if (ts.isShorthandPropertyAssignment(prop)) names.add(prop.name.text);
          else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
            names.add(prop.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile());
  return [...names].filter((n) => !NOT_SAMPLE_IDENTITY.has(n)).sort();
}

/**
 * The dependency array of the effect that discards the current sample.
 *
 * Two effects here call `discardSample()`: the unmount cleanup, written
 * `useEffect(() => () => discardSample(), [discardSample])`, and the
 * invalidation effect. The cleanup appears first, and matching on the call alone
 * silently compares the payload against `[discardSample]` — which fails every
 * prop and reads as "the deps are all missing" rather than "I matched the wrong
 * effect". `setState` is what tells them apart: only the invalidation effect
 * resets the player's own state.
 */
function invalidationDeps(): string[] {
  const file = sourceFile();
  let found: string[] | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'useEffect') {
      const body = node.arguments[0];
      const deps = node.arguments[1];
      if (body && deps && ts.isArrayLiteralExpression(deps)
        && body.getText().includes('discardSample()')
        && body.getText().includes('setState(')) {
        found = deps.elements.map((el) => el.getText());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(found?.[1], 'expected the invalidation effect, matched by discardSample() + setState()');
  assert.ok((found as string[]).length > 3,
    `the matched effect has only ${(found as string[]).length} deps — likely the wrong effect`);
  return found!;
}

/** The ROOT identifier of a dependency expression: `voiceSettings?.x` -> `voiceSettings`. */
function rootName(expr: string): string {
  return (expr.split(/[.?[]/)[0] ?? expr).trim();
}

/** Props reached through a DERIVED, content-stable dependency.
 *
 *  `corrections` is an array, so listing the array itself re-runs the effect on
 *  every render and discards a sample the instant it finishes. The component
 *  therefore depends on `correctionsKey`, a useMemo over the serialized pairs. An
 *  allowlist is only honest if the derivation is checked too, so
 *  `every derived dependency is derived from the prop it stands for` verifies each
 *  entry returns the key helper applied to the prop and depends on that prop. */
const DERIVED: Record<string, string> = { corrections: 'correctionsKey' };

/** Every request prop, mapped to the dep that covers it. */
function coverage(): Map<string, string> {
  const roots = new Set(invalidationDeps().map(rootName));
  const map = new Map<string, string>();
  for (const prop of requestProps()) {
    if (roots.has(prop)) map.set(prop, prop);
    else if (DERIVED[prop] && roots.has(DERIVED[prop])) map.set(prop, DERIVED[prop]);
  }
  return map;
}

/**
 * For each prop whose declared type is an inline object literal, the member names
 * it declares — i.e. the settings that actually reach the render request.
 *
 * Read from the `VoicePreviewButtonProps` interface rather than restated, because
 * a restated list is a list that stops being true the moment someone adds a
 * slider. `fishSettings` is included on purpose: it is the field that was already
 * listed correctly, so if this ever starts exempting it the exemption is visible.
 */
function nestedMemberProps(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const file = sourceFile();
  const visit = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'VoicePreviewButtonProps') {
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || !member.name || !ts.isIdentifier(member.name)) continue;
        const t = member.type;
        if (!t || !ts.isTypeLiteralNode(t)) continue;
        const names = t.members
          .filter((m): m is ts.PropertySignature => ts.isPropertySignature(m))
          .map((m) => (m.name && ts.isIdentifier(m.name) ? m.name.text : ''))
          .filter(Boolean);
        if (names.length) out.set(member.name.text, names);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(out.size >= 2, `expected voiceSettings and fishSettings in the props, found [${[...out.keys()]}]`);
  return out;
}

test('every prop that shapes the sample invalidates it', () => {
  const requested = requestProps();
  const covered = coverage();
  const roots = new Set(invalidationDeps().map(rootName));

  assert.ok(requested.length >= 10, `expected a full payload, parsed ${requested.length}`);

  const missing = requested.filter((p) => !covered.has(p));
  assert.deepEqual(
    missing, [],
    `these props reach the render request but no dependency invalidates the sample, so `
      + `changing them leaves the previous voice playing under the new label: ${missing.join(', ')}`,
  );

  // A root match is NOT coverage for an object's fields. `voiceSettings` reaching
  // the request as a whole object means the request carries FOUR sliders, and one
  // surviving dependency satisfies `roots.has('voiceSettings')` — so deleting
  // `voiceSettings?.voiceStability` on its own still passed. That is not a
  // hypothetical: it is exactly what a partial cleanup leaves behind, and the
  // previous version of this test could not see it.
  //
  // The required members are read from the declared props interface rather than
  // restated here, so adding a slider to the component cannot quietly exempt it.
  const nested = nestedMemberProps();
  const uncoveredMembers: string[] = [];
  for (const [parent, members] of nested) {
    if (!requested.includes(parent)) continue;
    for (const member of members) {
      if (!invalidationDeps().includes(`${parent}?.${member}`)) {
        uncoveredMembers.push(`${parent}?.${member}`);
      }
    }
  }
  assert.deepEqual(
    uncoveredMembers, [],
    `these settings reach the render request but no dependency invalidates the sample when `
      + `they change: ${uncoveredMembers.join(', ')}. Each field needs its own dependency — one `
      + `surviving \`${Object.keys(nested)[0]}?.…\` entry is not coverage for the rest.`,
  );
  assert.ok(roots.size > 0, 'deps must parse to something');
});

test('editing the sample text discards the stale audio', () => {
  // Named on its own because it is the one an operator hits by typing, and the
  // one that was missing. A `<textarea>` bound to `text` with no `text` in the
  // invalidation deps leaves the old recording audible under the new words.
  const roots = new Set(invalidationDeps().map(rootName));
  assert.ok(roots.has('text'),
    'text must invalidate the sample; without it the preview ignores the text it is previewing');
});

function assertDerivedMemo(source: string, prop: string, derived: string): void {
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.name.text === derived) declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile(source));
  assert.equal(declarations.length, 1, `expected one declaration of ${derived}`);
  const memo = declarations[0]?.initializer;
  assert.ok(memo && ts.isCallExpression(memo) && ts.isIdentifier(memo.expression)
    && memo.expression.text === 'useMemo', `${derived} must be a useMemo`);
  const [callback, deps] = memo.arguments;
  assert.ok(deps && ts.isArrayLiteralExpression(deps), `${derived} must have a dependency array`);
  assert.deepEqual(deps.elements.map((dep) => dep.getText()), [prop],
    `${derived} must depend on [${prop}]`);
  assert.ok(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)),
    `${derived} must have a memo callback`);

  // Check the value the callback returns, not a helper name anywhere in its text.
  // [corrections] alone also permits a constant key computed from [].
  const body = callback.body;
  const statement = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : undefined;
  let returned = ts.isBlock(body)
    ? (statement && ts.isReturnStatement(statement) ? statement.expression : undefined)
    : body;
  while (returned && ts.isParenthesizedExpression(returned)) returned = returned.expression;
  const helper = DERIVED_CALL[derived];
  assert.ok(helper, `expected a key helper for ${derived}`);
  assert.ok(returned && ts.isCallExpression(returned)
    && ts.isIdentifier(returned.expression) && returned.expression.text === helper
    && returned.arguments.length === 1
    && returned.arguments[0] && ts.isIdentifier(returned.arguments[0])
    && returned.arguments[0].text === prop,
  `${derived} must return ${helper}(${prop})`);
}

test('every derived dependency is derived from the prop it stands for', () => {
  for (const [prop, derived] of Object.entries(DERIVED)) {
    assert.ok(invalidationDeps().map(rootName).includes(derived),
      `${derived} is allowlisted for ${prop} but is not a dependency`);
    assertDerivedMemo(SRC, prop, derived);
  }
});

test('the derived dependency guard rejects a key computed from an empty list', () => {
  const mutated = SRC.replace('correctionsDependency(corrections)', 'correctionsDependency([])');
  assert.notEqual(mutated, SRC, 'the mutation must replace the real key input');
  assert.throws(
    () => assertDerivedMemo(mutated, 'corrections', 'correctionsKey'),
    /must return correctionsDependency\(corrections\)/,
  );
});

/** Where each derived dependency's key function lives, keyed by the dep name. */
const DERIVED_CALL: Record<string, string> = {
  correctionsKey: 'correctionsDependency',
};

test('no dep is an unstable object or array literal', () => {
  // The reason voiceSettings and corrections are absent as objects. If someone
  // "simplifies" by adding the object back, the effect fires every render and
  // discards the sample before it can be played.
  const unstable = invalidationDeps()
    .filter((d) => /^(voiceSettings|corrections|fishSettings)$/.test(d));
  assert.deepEqual(
    unstable, [],
    'list the scalar fields instead of the object — an inline object at the call site '
      + 're-runs this effect on every render',
  );
});

test('the effect body actually discards, and the payload still carries every prop', () => {
  // Guards the parse itself: a test that silently matched no effect, or a payload
  // that failed to parse, would report a clean comparison of two empty lists.
  const deps = invalidationDeps();
  assert.ok(deps.includes('discardSample'), 'discardSample must be a dep');
  assert.ok(deps.includes('voice'), 'voice must be a dep');
  for (const prop of ['engine', 'voice', 'cloudProvider', 'speed', 'language']) {
    assert.ok(requestProps().includes(prop), `${prop} should be in the render payload`);
  }
});
