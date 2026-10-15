// Pins GET /themes' public read shape (#1300 bug 12).
//
// The endpoint answers "which theme should I paint" AND "which level decided
// that" — because reporting only the resolved id made "the setting didn't
// stick" and "a show is pinning its own palette" the same response, which is
// the reported bug: an operator saves a station theme, the admin UI applies it,
// and ThemeProvider's next poll repaints it away with nothing anywhere able to
// say why.
//
// Three contracts matter, and all three are load-bearing for a client that
// already shipped:
//
//   1. `active` keeps the value it has always had, in every case. The web
//      ThemeProvider and the Expo player read nothing else; provenance is
//      purely additive or it is a breaking change.
//   2. A show wins ONLY while its themeId still resolves to a known theme. A
//      stale pin (operator deleted the JSON) falls back to the station default
//      rather than painting nothing — the same lenient fallback the rest of the
//      theme system uses.
//   3. `activeShow` is null, never absent, when the station default wins, so a
//      client can destructure it without a presence check.
//
// Run: `tsx scripts/theme-provenance.test.ts` (or `npm test -- theme-prov`).

import assert from 'node:assert/strict';
import { resolveThemeProvenance } from '../src/util/theme-provenance.js';

const themeIds = ['classic-light', 'vinyl', 'blueprint'];

// ── the station default wins ─────────────────────────────────────────────────

// Nothing on air.
{
  const p = resolveThemeProvenance({ stationDefault: 'vinyl', activeShow: null, themeIds });
  assert.equal(p.active, 'vinyl', 'active is the station default');
  assert.equal(p.activeSource, 'station');
  assert.equal(p.stationDefault, 'vinyl');
  assert.equal(p.activeShow, null, 'activeShow is null, not undefined');
  assert.ok('activeShow' in p, 'the key is present so a client can destructure it');
}

// A show is on air but pins no theme — the common case, most shows don't.
{
  const p = resolveThemeProvenance({
    stationDefault: 'vinyl',
    activeShow: { id: 's1', name: 'Breakfast', themeId: '' },
    themeIds,
  });
  assert.equal(p.active, 'vinyl');
  assert.equal(p.activeSource, 'station');
  assert.equal(p.activeShow, null, 'a show that pins nothing did not decide anything');
}

// ── the show wins ────────────────────────────────────────────────────────────

{
  const p = resolveThemeProvenance({
    stationDefault: 'vinyl',
    activeShow: { id: 's1', name: 'The Late Shift', themeId: 'blueprint' },
    themeIds,
  });
  assert.equal(p.active, 'blueprint', 'the on-air show outranks the station default');
  assert.equal(p.activeSource, 'show');
  assert.equal(p.stationDefault, 'vinyl', 'the saved default is still reported, and still saved');
  assert.deepEqual(p.activeShow, { id: 's1', name: 'The Late Shift', themeId: 'blueprint' });
}

// The reported symptom in full: a show pins its own theme, so the station theme
// the operator just saved is NOT what anyone sees. `stationDefault !== active`
// is exactly the signal the admin notice renders on.
{
  const p = resolveThemeProvenance({
    stationDefault: 'classic-light', // just saved in admin
    activeShow: { id: 's1', name: 'The Late Shift', themeId: 'blueprint' },
    themeIds,
  });
  assert.notEqual(p.active, p.stationDefault, 'the save is outranked, and the response says so');
  assert.equal(p.activeSource, 'show');
}

// A show pinning the theme the station already defaults to is a no-op anyone
// can see — still reported honestly, and the UI is what decides to stay quiet.
{
  const p = resolveThemeProvenance({
    stationDefault: 'blueprint',
    activeShow: { id: 's1', name: 'The Late Shift', themeId: 'blueprint' },
    themeIds,
  });
  assert.equal(p.active, 'blueprint');
  assert.equal(p.activeSource, 'show', 'the show did decide it, even though nothing looks different');
  assert.equal(p.active, p.stationDefault);
}

// ── a stale pin must not paint nothing ───────────────────────────────────────

// The theme file was deleted under our feet (or a built-in id was retired —
// see show-schema.test.ts for the validator half of the same story).
{
  const p = resolveThemeProvenance({
    stationDefault: 'vinyl',
    activeShow: { id: 's1', name: 'The Late Shift', themeId: 'sunset' },
    themeIds,
  });
  assert.equal(p.active, 'vinyl', 'an unresolvable pin falls back to the station default');
  assert.equal(p.activeSource, 'station', 'and the station is honestly credited with the decision');
  assert.equal(p.activeShow, null, 'so the admin UI stays quiet — the default really is winning');
}

// An empty registry can't resolve anything, so the station default stands.
{
  const p = resolveThemeProvenance({
    stationDefault: 'vinyl',
    activeShow: { id: 's1', name: 'The Late Shift', themeId: 'blueprint' },
    themeIds: [],
  });
  assert.equal(p.active, 'vinyl');
  assert.equal(p.activeSource, 'station');
}

// ── malformed stored shapes degrade, never throw ─────────────────────────────

// settings.json is operator-editable and has carried several show shapes over
// time. A non-string themeId must read as "no pin", not crash a public read.
{
  const p = resolveThemeProvenance({
    stationDefault: 'vinyl',
    activeShow: { id: 's1', name: 'Breakfast', themeId: 42 },
    themeIds,
  });
  assert.equal(p.active, 'vinyl');
  assert.equal(p.activeSource, 'station');
}

// A nameless show still publishes a string name — the admin notice falls back
// to the id for display, but the wire shape never carries undefined.
{
  const p = resolveThemeProvenance({
    stationDefault: 'vinyl',
    activeShow: { id: 's1', themeId: 'blueprint' },
    themeIds,
  });
  assert.deepEqual(p.activeShow, { id: 's1', name: '', themeId: 'blueprint' });
}

// An absent show (undefined, not null) is the same as no show.
{
  const p = resolveThemeProvenance({ stationDefault: 'vinyl', themeIds });
  assert.equal(p.activeSource, 'station');
  assert.equal(p.activeShow, null);
}

console.log('theme-provenance: ok');
