// Per-effect transition switches (#1565) — the operator lever that is narrower
// than `djMode`.
//
// Five things regress here, each reached from a different line so any one of
// them going missing is silent:
//
//  - ABSENT MEANS ON. A station that has never written the block behaves
//    exactly as it did before the block existed, and so does one whose stored
//    block is malformed. This is what makes the upgrade byte-identical.
//  - The PATCH is per-field. `transitions.effects` is a nested block, so the
//    applier needs its own loop: a patch naming only `dissolve` must not reset
//    the other five.
//  - The PROMPT gates before generation. A switched-off gesture is dropped from
//    the pool path's enum and named as unavailable in the guidance, and with
//    every one off the whole block disappears — the same prompt a non-DJ
//    persona gets.
//  - The DRAIN strip is TARGETED. Sweep shapes entry and washout exit, so a
//    pick can legitimately carry both; switching one off must not take the
//    other with it (which is what the blanket stripEffect would do).
//  - The AUTO-WASHOUT honours the switch. It is deterministic rather than a DJ
//    choice, but it is the same gesture at the same cost.
//
// Plus a drift check on the admin form's copy of the list, which cannot import
// the controller's.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'subwave-transition-effects-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { TRANSITION_EFFECTS } = await import('../src/settings/vocab.js');
const { effectEnabled, enabledEffects } = await import('../src/settings/transition-effects.js');
const dj = await import('../src/llm/dj.js');
const { queue } = await import('../src/broadcast/queue.js');

const here = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PANEL = join(here, '..', '..', 'web', 'components', 'admin', 'SettingsPanel.tsx');

// A DJ-mode persona, so effectsActive() is true and the prompt offers the kit.
async function seedDjMode() {
  await settings.load();
  const personas = settings.get().personas.map((p, i) => (i === 0 ? { ...p, djMode: true } : p));
  await settings.update({ personas });
}

test('an absent or malformed block reads as the whole kit on', async () => {
  await settings.load();
  // The resolver is handed the settings object directly, so these are the
  // shapes a hand-edited or half-written settings.json actually produces.
  for (const stored of [{}, { transitions: {} }, { transitions: { effects: null } },
    { transitions: { effects: 'yes' } }, { transitions: { effects: { dissolve: 'false' } } }]) {
    for (const kind of TRANSITION_EFFECTS) {
      assert.equal(effectEnabled(kind, stored), true,
        `${kind} stays on for ${JSON.stringify(stored)} — only an explicit false switches one off`);
    }
  }
  // Only the boolean turns it off. 'false'-the-string above is a stored value
  // no schema would have written, and it must not mute the gesture.
  assert.equal(effectEnabled('dissolve', { transitions: { effects: { dissolve: false } } }), false);
});

test('the shipped defaults are the whole kit, so an upgrade changes nothing', async () => {
  await settings.load();
  assert.deepEqual(enabledEffects(), [...TRANSITION_EFFECTS]);
});

test('a patch naming one effect leaves the other five alone', async () => {
  await settings.load();
  await settings.update({ transitions: { effects: { dissolve: false } } });
  assert.equal(effectEnabled('dissolve'), false, 'the named effect is switched off');
  assert.deepEqual(enabledEffects(), TRANSITION_EFFECTS.filter(k => k !== 'dissolve'),
    'the nested block is merged, not replaced');

  // ...and switching it back on is symmetric.
  await settings.update({ transitions: { effects: { dissolve: true } } });
  assert.deepEqual(enabledEffects(), [...TRANSITION_EFFECTS]);

  // A sibling key in the same block is untouched by an effects-only patch.
  await settings.update({ transitions: { pairDrain: false } });
  await settings.update({ transitions: { effects: { chop: false } } });
  assert.equal(settings.get().transitions.pairDrain, false, 'pairDrain survives an effects patch');
  await settings.update({ transitions: { pairDrain: true, effects: { chop: true } } });
});

test('disabled effects and untouched defaults survive a cold load', async () => {
  await settings.load();
  await settings.update({ transitions: { effects: { dissolve: false, chop: false } } });
  setCache(null);
  await settings.load();
  assert.deepEqual(enabledEffects(), TRANSITION_EFFECTS.filter(k => k !== 'dissolve' && k !== 'chop'));
  await settings.update({ transitions: { effects: { dissolve: true, chop: true } } });
});

test('the pool prompt drops a switched-off gesture before the model ever sees it', async () => {
  await seedDjMode();
  assert.ok(dj.effectsGuidance().includes('TRANSITION EFFECTS'), 'the kit is coached by default');
  assert.ok(!/Switched off/.test(dj.effectsGuidance()), 'nothing is named unavailable by default');

  await settings.update({ transitions: { effects: { dissolve: false, chop: false } } });
  const guidance = dj.effectsGuidance();
  assert.match(guidance, /Switched off on this station right now: "dissolve", "chop"/);
  assert.ok(guidance.includes('TRANSITION EFFECTS'), 'the rest of the coaching survives');

  // With the whole kit off there is nothing left to coach, and the block goes
  // entirely rather than degrading into a list of six refusals.
  await settings.update({
    transitions: { effects: Object.fromEntries(TRANSITION_EFFECTS.map(k => [k, false])) },
  });
  assert.equal(dj.effectsGuidance(), '', 'every effect off reads exactly like DJ mode off');

  await settings.update({
    transitions: { effects: Object.fromEntries(TRANSITION_EFFECTS.map(k => [k, true])) },
  });
});

test('the drain strips only the switched-off gesture, never its partner', async () => {
  await seedDjMode();
  await settings.update({ transitions: { effects: { sweep: false } } });

  // Sweep shapes the ENTRY into this pick, washout its EXIT — one pick may
  // carry both, and this is the case the blanket stripEffect() would get wrong.
  queue.current = { track: { id: 'on-air', title: 'On air', artist: 'A', duration: 300 } } as never;
  const pick = {
    track: { id: 'pick', title: 'Pick', artist: 'B', duration: 300, sweep: true, washout: true },
  } as never;
  queue.upcoming = [pick];
  queue.applyMixTransition(pick);

  const track = (pick as { track: Record<string, unknown> }).track;
  assert.equal(track.sweep, undefined, 'the switched-off sweep is gone');
  assert.equal(track.washout, true, 'the washout it shared the pick with survives');

  await settings.update({ transitions: { effects: { sweep: true } } });
});

test('the length-cap auto-washout honours the washout switch', async () => {
  await seedDjMode();
  // maxTrackSeconds well under the pick's duration, so the drain wants to cut
  // it and would normally arm the washout to make the cut sound intentional.
  await settings.update({ maxTrackSeconds: 120 });
  queue.current = { track: { id: 'on-air', title: 'On air', artist: 'A', duration: 300 } } as never;

  const armed = { track: { id: 'p1', title: 'Long', artist: 'B', duration: 900 } } as never;
  queue.upcoming = [armed];
  queue.applyMixTransition(armed);
  assert.equal((armed as { track: Record<string, unknown> }).track.washout, true,
    'a capped exit arms the washout while the switch is on');

  await settings.update({ transitions: { effects: { washout: false } } });
  const bare = { track: { id: 'p2', title: 'Long', artist: 'B', duration: 900 } } as never;
  queue.upcoming = [bare];
  queue.applyMixTransition(bare);
  assert.equal((bare as { track: Record<string, unknown> }).track.washout, undefined,
    'with the washout switched off the capped cut is a plain crossfade');

  await settings.update({ maxTrackSeconds: 0, transitions: { effects: { washout: true } } });
});

test('the admin form names the same six gestures the controller does', () => {
  // The panel's operator copy must cover the entire shared vocabulary.
  const src = readFileSync(SETTINGS_PANEL, 'utf8');
  const block = src.match(/const TRANSITION_EFFECT_FIELDS = \[[\s\S]*?\n\] as const/);
  assert.ok(block, 'SettingsPanel.tsx still declares TRANSITION_EFFECT_FIELDS');
  const ids = [...block[0].matchAll(/^\s{4}id: '([a-z]+)',$/gm)].map(m => m[1]);
  assert.deepEqual(ids, [...TRANSITION_EFFECTS],
    'the admin form lists every effect, in the controller\'s order');
});

test.after(() => rmSync(root, { recursive: true, force: true }));
