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

function sourceFile(): ts.SourceFile {
  return ts.createSourceFile(
    'VoicePreviewButton.tsx', SRC, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
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
 *  therefore depends on `correctionsKey`, a useMemo over the joined pairs. An
 *  allowlist is only honest if the derivation is checked too, so
 *  `every derived dependency is derived from the prop it stands for` verifies each
 *  entry is a useMemo whose dependency array is the prop it claims to cover. */
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

test('every prop that shapes the sample invalidates it', () => {
  const requested = requestProps();
  const covered = coverage();

  assert.ok(requested.length >= 10, `expected a full payload, parsed ${requested.length}`);

  const missing = requested.filter((p) => !covered.has(p));
  assert.deepEqual(
    missing, [],
    `these props reach the render request but no dependency invalidates the sample, so `
      + `changing them leaves the previous voice playing under the new label: ${missing.join(', ')}`,
  );
});

test('editing the sample text discards the stale audio', () => {
  // Named on its own because it is the one an operator hits by typing, and the
  // one that was missing. A `<textarea>` bound to `text` with no `text` in the
  // invalidation deps leaves the old recording audible under the new words.
  const roots = new Set(invalidationDeps().map(rootName));
  assert.ok(roots.has('text'),
    'text must invalidate the sample; without it the preview ignores the text it is previewing');
});

test('every derived dependency is derived from the prop it stands for', () => {
  // Without this the allowlist above is just a way to make the test pass: an
  // unrelated useMemo named correctionsKey would satisfy it while the real array
  // stayed untracked.
  for (const [prop, derived] of Object.entries(DERIVED)) {
    assert.ok(invalidationDeps().map(rootName).includes(derived),
      `${derived} is allowlisted for ${prop} but is not a dependency`);
    const memo = new RegExp(
      `const\\s+${derived}\\s*=\\s*useMemo\\([\\s\\S]*?\\n\\s*\\[${prop}\\][\\s\\S]*?\\);`,
    ).exec(SRC);
    assert.ok(memo,
      `${derived} must be a useMemo whose dependency array is [${prop}] — otherwise the `
      + `allowlist is covering ${prop} with something unrelated`);
  }
});

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