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
// invalidates it when the props that shape the audio change. The invalidation
// effect's dependency array is a SECOND, hand-maintained list of those props,
// and it had drifted: geminiModel, voiceStyle, text and corrections all reach the
// render request and none were listed. Editing a persona's delivery directive
// therefore left the previous voice playing underneath the new label — the exact
// stale-sample case the effect exists to prevent.
//
// This compares the two lists by AST rather than by regex, because the failure
// is a semantic one: a prop can be spelled in the payload and reached in the
// deps through a different expression (`corrections` becomes `correctionsKey`,
// `voiceSettings` becomes four scalar reads), and only the compiler knows that.

// Props that legitimately do not invalidate. `adminFetch` is plumbing and
// `ac.signal` is per-request; neither is part of a sample's identity.
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
    // `fetchPreviewSample(adminFetch, { engine, voice, ... }, ac.signal)`
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

/** The dependency array of the effect that discards the current sample. */
function invalidationDeps(): string[] {
  const file = sourceFile();
  let found: string[] | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    // TWO effects in this file call discardSample(): the unmount cleanup, written
    // `useEffect(() => () => discardSample(), [discardSample])`, and the
    // invalidation effect. The cleanup appears first, and matching on
    // discardSample() alone silently compares the payload against `[discardSample]`
    // — which fails every prop and reads as "the deps are all missing" rather
    // than "I matched the wrong effect". setState is what tells them apart: only
    // the invalidation effect resets the player's own state.
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
  assert.ok(found, 'no effect that discards AND resets state with a dependency array');
  assert.ok((found as string[]).length > 3,
    `the matched effect has only ${(found as string[]).length} deps — likely the wrong effect`);
  return found!;
}

/** Props reached through a DERIVED, content-stable dependency.
 *
 *  `corrections` is an array, so listing the array itself in the deps re-runs the
 *  effect on every render and throws away a sample the instant it finishes. The
 *  component therefore depends on `correctionsKey`, a useMemo over the joined
 *  from/to pairs. An allowlist is only honest if the derivation is checked too, so
 *  `every derived dependency is derived from the prop it stands for` verifies each
 *  entry is a useMemo whose dependency array is the prop it claims to cover. */
const DERIVED: Record<string, string> = { corrections: 'correctionsKey' };

/** The ROOT identifier of a dependency expression: `voiceSettings?.x` -> `voiceSettings`. */
function rootName(expr: string): string {
  return (expr.split(/[.?[]/)[0] ?? expr).trim();
}

/** Every prop the render request sends, mapped to the dep name that covers it. */
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

test('the bare `voiceStyle` regression cannot come back', () => {
  // Named on its own because it is the one an operator edits by typing: the
  // persona delivery directive. The absence was invisible — the control worked,
  // the sample played, it was just the wrong voice.
  const roots = new Set(invalidationDeps().map(rootName));
  assert.ok(roots.has('voiceStyle'),
    'voiceStyle must invalidate the sample; without it the preview ignores the directive');
  // ElevenLabs' numeric `voiceStyle` shares the name, so its scalars are listed
  // rather than the object — depending on an inline `{}` re-runs the effect every
  // render and throws away a sample the instant it finishes rendering.
  const deps = invalidationDeps();
  assert.ok(deps.includes('voiceSettings?.voiceStyle'),
    'the ElevenLabs voiceStyle scalar must be listed individually');
});

test('no dep is an unstable object or array literal', () => {
  // The reason voiceSettings and corrections are absent as objects. If someone
  // "simplifies" by adding the object back, the effect fires every render and
  // discards the sample before it can be played.
  const unstable = invalidationDeps().filter((d) => /^(voiceSettings|corrections|fishSettings)$/.test(d));
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