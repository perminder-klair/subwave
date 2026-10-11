// The two meanings of `personaTts: null` on a RescueSlot.
//
// `resolveEngine()` returns a slot for the engine that will speak a segment. A
// null override normally means "no operator voice here", and `speak()` fills it
// back in from the persona so the persona's own voice applies. But when the
// engine was SUBSTITUTED — a persona on an unconfigured cloud provider, where
// the engine id stays the same and only the provider can change — filling it
// back in reattaches the provider `engineUsable()` had just rejected, so the
// "rescued" render goes straight back to the dead one.
//
// `plainSlot` and `stationSlot` are therefore different slots, and conflating
// them is the whole bug. Asserted on the source because the claim is about a
// value that differs only by an optional boolean: there is no seam to drive
// `speak()` through without standing up engines and credentials.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const tts = readFileSync(new URL('../src/audio/tts.ts', import.meta.url), 'utf8');
const fb = readFileSync(new URL('../src/audio/tts-fallback.ts', import.meta.url), 'utf8');

test('station-default slots are their own constructor, and only the real hops use it', () => {
  // `plainSlot` is resolveEngine's ORDINARY return. Marking IT as station-default
  // drops the persona's own voice on every successful resolution — which is
  // exactly what a first attempt at this fix did, and it was caught by
  // gemini-exchange-air.test.ts rendering both speakers as Puck.
  assert.match(tts, /function plainSlot\(engine: string\): RescueSlot \{\s*return \{ engine, personaTts: null \};\s*\}/,
    'plainSlot is the ordinary resolution: the persona\'s voice must still apply');
  assert.match(tts, /function stationSlot\(engine: string\): RescueSlot \{\s*return \{ engine, personaTts: null, stationDefault: true \};\s*\}/,
    'the station default needs its own constructor so the intent survives at the call site');

  // Every hop where the engine was substituted, in resolveEngine and in the
  // mid-render chain. Partial coverage is the failure mode: marking one site
  // leaves the others unmarked and every assertion here still passes.
  const hops = [
    [tts, "if (!ENGINES.includes(chosen)) return stationSlot('piper');"],
    [tts, 'if (tts.defaultEngine && tts.defaultEngine !== chosen) return stationSlot(tts.defaultEngine);'],
    [tts, 'return stationSlot(tts.defaultEngine);'],
    [tts, "return stationSlot('piper');"],
    [fb, 'stationDefault: true,'],
  ] as const;
  for (const [src, hop] of hops) {
    assert.ok(src.includes(hop), `this system-chosen rung must carry the marker: ${hop}`);
  }

  // And the negative direction, which is the one that bites: the ONLY plainSlot
  // inside resolveEngine is the ordinary return. A hop that drifted back to
  // `plainSlot(...)` would silently regain the persona's dead provider, and
  // every positive assertion above still passes.
  const body = tts.slice(tts.indexOf('function resolveEngine('));
  const fn = body.slice(0, body.indexOf('\n}\n'));
  const unmarked = fn.match(/return plainSlot\((?!chosen\))/g);
  assert.equal(unmarked, null,
    `every hop inside resolveEngine must return stationSlot, not plainSlot: ${unmarked}`);
});

test('speak() does not reattach the persona override to a station-default slot', () => {
  // The defect, verbatim. A bare `?? personaTts` cannot tell a station default
  // apart from a configured slot that left the voice blank.
  assert.doesNotMatch(tts, /const primaryPersonaTts = primarySlot\.personaTts \?\? personaTts;/,
    'the unguarded backfill in speak() is the reported defect');
  assert.match(tts, /primarySlot\.personaTts\s*\n?\s*\?\? \(primarySlot\.stationDefault \? null : personaTts\)/,
    'the substitution must be guarded by the marker');
});

test('the /debug routing report applies the same distinction as speak()', () => {
  // `describeRouting()` reports what /debug and /stats show. Without the marker
  // consulted here it named the provider the availability probe had just
  // rejected, while speak() spoke with the station's — so the admin panel named
  // a target that was not the one talking (#1793).
  assert.match(tts, /const personaCloud = personaTts\?\.engine === 'cloud' && !slot\.stationDefault;/,
    'the reported voice/provider must ignore the persona on a station-default cloud slot');
  assert.match(tts, /voice = personaCloud \? personaTts\.voice : tts\.cloud\?\.voice;/,
    'a station-default cloud slot reports the station voice');
});

test('describeRouting reports fellBack consistently with speak()', () => {
  // This is `describeRouting()`'s payload, NOT the rescue loop. An earlier
  // version of this file described it as the mid-render path and claimed the
  // dispatch was fixed here; the dispatch in `speak()` passes `slot.personaTts`
  // straight through and never did a backfill (see the next test). What this
  // guards is the REPORTED `fellBack` flag agreeing with what speak() sends.
  assert.doesNotMatch(tts, /slot\.personaTts \?\? personaTts/,
    'the unguarded backfill in the routing report is the reported defect');
  assert.match(tts, /slot\.personaTts \?\? \(slot\.stationDefault \? null : personaTts\)/,
    'the report must guard on the marker, as speak() does');
});

test('the rescue loop forwards the slot override with no backfill at all', () => {
  // The pre-existing invariant, pinned because it is easy to "fix" by adding a
  // backfill that looks symmetric with speak()'s. It must stay as it is: the
  // slot's own override is what probe and call agree on.
  // Bounded to the `for` loop itself. Slicing to end-of-file also covers
  // describeRouting(), whose guarded `slot.personaTts ?? (…)` is the FIX rather
  // than a violation — which is how the first version of this test failed
  // against a correct file.
  const start = tts.indexOf('for (const slot of chain) {');
  assert.ok(start > 0, 'the mid-render rescue loop must exist');
  const loop = tts.slice(start, tts.indexOf('\n      }', start));
  assert.match(loop, /speakWith\(fallback, rescueText, \{[^}]*\}, slot\.personaTts\)/,
    'the rescue must pass slot.personaTts directly — no persona backfill belongs here');
  assert.doesNotMatch(loop, /slot\.personaTts \?\?/,
    'adding a backfill to the rescue loop would re-apply the credentials its own probe rejected');
});
