import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The name collision.
//
// `voiceStyle` is BOTH this station's string delivery directive — free text an
// operator writes to change HOW a persona speaks — AND ElevenLabs' numeric style
// slider, a 0–1 float. They are different fields that happen to share a name, on
// different objects:
//
//   the STRING rides the top-level `opts` object that reaches every engine
//   the NUMBER rides `cloudOverride.voiceStyle`, built from cloudVoiceSettings
//
// Nothing merges them today, and this file is why that stays true.
//
// ## What a leak would actually do
//
// `cloud.speak` composes `const c = { ...base, ...(cloudOverride || {}) }` and
// then hands `c.voiceStyle` STRAIGHT to ElevenLabs:
//
//   style: c.voiceStyle,
//
// There is no clamp on that line. `stability` beside it is defensively snapped
// (`isElevenLabsV3(c.model) ? snapV3Stability(...)`) precisely because a tuned
// slider must not be able to 400 the call — `style` never got the same
// treatment. So a string arriving here is not coerced or dropped, it is sent as
// `voice_settings.style: "warm, unhurried"`, ElevenLabs 400s, and the line drops
// into the fallback chain. The persona silently stops using the voice it was
// configured with, and nothing local reports why.
//
// ## Why this is source-scan rather than behavioural
//
// Interception is the house idiom here — `gemini-tts.test.ts` asserts that the
// Gemini branch SPREADS its resolved pick for the same reason: "a branch that
// resolved voice and model and then dropped one would keep every precedence test
// green." Driving a real ElevenLabs call to observe the outbound body would need
// the AI SDK stubbed deep enough to intercept `voice_settings`, which is more
// machinery than the invariant deserves.
//
// ## Why the two assertions below are load-bearing TOGETHER
//
// `cloudOverride` composing no `voiceStyle` is necessary but not sufficient: it
// is a spread of `opts.cloudVoiceSettings`, so a string could arrive THROUGH that
// object instead. The clamp in the one producer is the other half. Remove either
// and the leak is open.
//
// A historical note, because it is the reason this is written the way it is. An
// earlier version of this guard used `voiceStyle\s*(?![,}\s]*[,}])`, which is
// exempt for shorthand `voiceStyle,` and `voiceStyle}` — so it MISSED the exact
// shape that leaks, while its own failure message promised the directive could not
// be passed "under any spelling". A regex that enumerates the wrong spellings is
// worse than none, because it reads as coverage. This one does not enumerate.

const ttsSrc = readFileSync(new URL('../src/audio/tts.ts', import.meta.url), 'utf8');
const cloudSrc = readFileSync(
  new URL('../src/llm/internal/speech/cloud-speech.ts', import.meta.url), 'utf8',
);

/**
 * A DEFINING occurrence of the bare `voiceStyle` token.
 *
 * Inside `cloudOverride` the token may only ever appear as a MEMBER READ
 * (`opts.cloudVoiceSettings`, `c.voiceStyle`) — pulling the number out of an
 * object that legitimately holds it. Any bare token is a property being defined
 * there, and `cloudOverride` is composed from spreads alone.
 *
 * Lookbehind for `.`/word-char means it does not enumerate the spellings a
 * property can take (`voiceStyle:`, `voiceStyle,`, `voiceStyle}`, shorthand), which
 * is where the previous version leaked.
 */
const BARE_VOICE_STYLE = /(?<![.\w$])voiceStyle\b/;

test('cloudOverride never defines voiceStyle — only reads it', () => {
  // Slice the composition itself, so an unrelated `voiceStyle` elsewhere in the
  // function cannot satisfy or fail this.
  const start = ttsSrc.indexOf('const cloudOverride');
  assert.ok(start > 0, 'the cloudOverride composition must exist');
  const end = ttsSrc.indexOf('return cloud.speak', start);
  assert.ok(end > start, 'cloudOverride must be composed before the cloud call');
  const compose = ttsSrc.slice(start, end);

  const offending = compose
    .split('\n')
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => BARE_VOICE_STYLE.test(line));
  assert.deepEqual(
    offending.map(([n, line]) => `tts.ts:${n} ${line.trim()}`), [],
    'the string delivery directive must never be spread into cloudOverride — it would '
      + 'reach ElevenLabs as voice_settings.style and 400 the call, dropping the line into '
      + 'the fallback chain with nothing local reporting why',
  );
});

test('the guard fires on every spelling a property can take', () => {
  // The previous regex missed shorthand, which is the shape a spread-added field
  // takes. Checked against the shapes themselves so it cannot silently stop firing.
  for (const spelling of [
    'voiceStyle: opts.voiceStyle',   // the obvious regression
    'voiceStyle,',                   // shorthand among other properties
    'voiceStyle }',                  // shorthand as the last property
    '{ voiceStyle }',                // shorthand alone
    'voiceStyle :style',             // whitespace before the colon
    '...cloudVoiceSettings, voiceStyle',
  ]) {
    assert.match(spelling, BARE_VOICE_STYLE,
      `the guard must flag a DEFINING \`voiceStyle\` in cloudOverride: ${spelling}`);
  }
  // Member reads are the legitimate case and must not be flagged: that is how the
  // numeric reaches the provider.
  for (const reading of [
    '...opts.cloudVoiceSettings',
    '...(opts.cloudVoiceSettings || {})',
    'c.voiceStyle',
  ]) {
    assert.doesNotMatch(reading, BARE_VOICE_STYLE,
      `a MEMBER READ of voiceStyle is how the number gets through: ${reading}`);
  }
});

test('a destructuring rename reads as a definition — pinned, not hidden', () => {
  // A real limitation of any token-level check: in
  // `const { voiceStyle: n } = source` the token is a READ, but a destructuring
  // rename is textually identical to an object-literal property definition.
  // Flagged, deliberately: inside `cloudOverride` — four lines of pure spreads —
  // a destructuring read would be obvious, and the guarded slice has no
  // destructuring. Asserted so the limitation is a recorded decision rather than a
  // surprise for whoever hits it next.
  assert.match('const { voiceStyle: numeric } = opts.cloudVoiceSettings;',
    BARE_VOICE_STYLE, 'documented limitation: a destructuring RENAME reads as a definition');
});

test('cloudVoiceSettings has exactly ONE producer, and it never sees the directive', () => {
  // The other half of the invariant. `cloudOverride` composes no `voiceStyle`, but
  // it SPREADS `opts.cloudVoiceSettings` — so a string could arrive through that
  // object instead of being written into the literal. What closes that is the one
  // producer building the object from clamped numbers only.
  //
  // Three properties, because any one alone is insufficient: a second producer
  // that skips the clamp is as dangerous as writing the field directly; a clamp
  // that stops covering `voiceStyle` opens the same hole; and a producer that
  // started reading the directive would merge the two names in the one object
  // that is spread into `cloudOverride`.
  const declarations = [...ttsSrc.matchAll(/let\s+cloudVoiceSettings\b/g)];
  assert.equal(declarations.length, 1,
    `expected one producer of cloudVoiceSettings, found ${declarations.length}. A second one `
      + 'that does not clamp would reopen the path into cloudOverride.');

  const start = declarations[0].index!;
  const speakWith = ttsSrc.indexOf('speakWith(', start);
  assert.ok(speakWith > start, 'the producer must hand its object to speakWith');
  const build = ttsSrc.slice(start, speakWith);

  // Isolate the NUMERIC KEY LIST literal. Slicing to the first `}` does not work
  // and silently produces the wrong span — the first `}` in this block belongs to
  // `cloudVoiceSettings = {}`, two lines above the list.
  const keyListMatch = /\[[^\]]*'voiceSimilarityBoost'[^\]]*\]/.exec(build);
  assert.ok(keyListMatch, 'the numeric key list literal must exist');
  const keyList = keyListMatch[0];

  // The directive must not be read anywhere else in the producing block.
  // `voiceStyle` is the string's name AND one of the numeric keys, so the key
  // list is removed first and what remains is asserted clean.
  const withoutKeys = build.replace(keyList, '[]');
  assert.doesNotMatch(withoutKeys, /voiceStyle/,
    'the producing block must not read the string directive outside the numeric key list — the '
      + 'directive and the slider share this key name, and this object is spread straight into '
      + `cloudOverride. Offending line(s): ${withoutKeys.split('\n')
        .filter((l) => l.includes('voiceStyle')).map((l) => l.trim()).join(' | ')}`);

  // Every numeric key is read through clamp01, which DROPS a non-number. That drop
  // is the only thing between the string directive and ElevenLabs.
  const loopBody = build.slice(keyListMatch.index! + keyList.length);
  assert.match(loopBody.slice(0, loopBody.indexOf('}')), /clamp01\(/,
    'every numeric key must be read through clamp01');
  for (const key of ['voiceStability', 'voiceStyle', 'voiceSimilarityBoost']) {
    assert.ok(keyList.includes(`'${key}'`), `${key} must be in the clamped key list`);
  }
});

test('the directive and the sliders are handed over as SIBLINGS, never merged', () => {
  // The correct shape, asserted positively. `speakWith` receives `voiceStyle` (the
  // string) and `cloudVoiceSettings` (the numbers) as two separate properties of
  // one options object. The string is top-level; the numbers are inside the object
  // that becomes `cloudOverride`. A change that inlined the directive into
  // cloudVoiceSettings — or spread cloudVoiceSettings into the top level — would
  // collapse the two and is exactly what every other assertion here forbids.
  const call = ttsSrc.slice(ttsSrc.lastIndexOf('return speakWith('));
  const line = call.slice(0, call.indexOf(';'));
  assert.match(line, /\bvoiceStyle\b/, 'the directive rides the top-level options object');
  assert.match(line, /\bcloudVoiceSettings\b/, 'the sliders ride their own object');
  assert.doesNotMatch(line, /cloudVoiceSettings\s*:\s*\{[^}]*voiceStyle/,
    'the directive must not be nested inside cloudVoiceSettings');
});

test('the ElevenLabs style field is sent unclamped — the asymmetry is the hazard', () => {
  // `stability` beside it IS defensively snapped so a tuned slider cannot 400 the
  // call; `style` is not. That is why the two assertions above are load-bearing
  // rather than belt-and-braces: there is no downstream net for this field.
  //
  // If a future change adds a clamp here, this test fails and says why — at that
  // point the composition guard can be reconsidered rather than kept forever.
  assert.match(cloudSrc, /style: c\.voiceStyle,/,
    'ElevenLabs voice_settings.style is sent from c.voiceStyle with no clamp. If this now '
      + 'clamps, revisit whether cloudOverride still needs to exclude the directive.');
  assert.match(cloudSrc, /snapV3Stability\(c\.voiceStability\)/,
    'stability is defensively snapped; style is not. That asymmetry is why this file exists.');
});