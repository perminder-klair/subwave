// Regression tests for validateShowsStrict()'s per-show theme override
// (settings.ts). A show can pin `themeId` to a station theme. Built-in theme
// ids were RENAMED in 58c3782b ("sunset"/"lab"/"neon"/"press" retired for
// "blueprint"/"flare"/"recon"/"signal"), so installs that had a show pinned to
// a now-retired id carried a themeId that no longer resolves.
//
// The bug (reported on Discord): validateShowsStrict THREW on that stale id.
// Because update() re-validates the WHOLE shows array on any shows/schedule
// save — and POST /shows merges one edit into the full existing array — a
// single poisoned show bricked every show create/edit, schedule edit, and full
// restore with `shows[N].themeId "sunset" is not a known theme id`. The theme
// system already tolerates stale ids everywhere else (the lenient load path and
// serve-time getTheme() fall back to the station default), so strict validation
// must DROP an unknown id to "" rather than throw. It must NOT weaken any other
// strictness, and must never discard a valid (still-known) pick.
//
// Run: `tsx scripts/show-theme-id.test.ts`.

import assert from 'node:assert/strict';
import { validateShowsStrict } from '../src/settings.js';

const personas = [{ id: 'p_host' }, { id: 'p_guest' }];
const allowed = new Set(['classic-light', 'vinyl', 'blueprint']);

// ── the reported bug: a stale themeId must not brick the save ─────────────────

// A single show pinned to a retired built-in id validates and drops the id to
// "" (fall back to the station theme), instead of throwing.
{
  const out = validateShowsStrict(
    [{ name: 'Sunset Show', personaId: 'p_host', themeId: 'sunset' }],
    personas,
    allowed,
  );
  assert.equal(out.length, 1, 'show survives validation');
  assert.equal(out[0].themeId, '', 'stale "sunset" themeId is dropped to ""');
  assert.equal(out[0].name, 'Sunset Show', 'the rest of the show is preserved');
}

// The exact reported shape: editing one show while ANOTHER show (shows[1])
// still carries the retired id. The whole array must validate — the poisoned
// sibling can no longer block the edit — and only its dead id is dropped.
{
  const out = validateShowsStrict(
    [
      { name: 'Breakfast', personaId: 'p_host', themeId: 'vinyl' },
      { name: 'Old Show', personaId: 'p_guest', themeId: 'sunset' },
    ],
    personas,
    allowed,
  );
  assert.equal(out.length, 2, 'both shows validate');
  assert.equal(out[0].themeId, 'vinyl', 'the edited show keeps its valid theme');
  assert.equal(out[1].themeId, '', 'the poisoned sibling only loses its dead id');
}

// ── a valid pick is never discarded ───────────────────────────────────────────

{
  const out = validateShowsStrict(
    [{ name: 'Themed', personaId: 'p_host', themeId: 'blueprint' }],
    personas,
    allowed,
  );
  assert.equal(out[0].themeId, 'blueprint', 'a still-known themeId is preserved verbatim');
}

// Empty / missing themeId stays "" (no override) — unchanged behaviour.
{
  const out = validateShowsStrict(
    [
      { name: 'A', personaId: 'p_host', themeId: '' },
      { name: 'B', personaId: 'p_host' },
    ],
    personas,
    allowed,
  );
  assert.equal(out[0].themeId, '', 'explicit empty themeId stays empty');
  assert.equal(out[1].themeId, '', 'missing themeId stays empty');
}

// ── strictness is otherwise intact — we only softened the themeId branch ──────

// A dangling persona reference is still a hard error.
assert.throws(
  () => validateShowsStrict([{ name: 'Bad', personaId: 'p_nope' }], personas, allowed),
  /personaId must reference an existing persona/,
  'unknown personaId still throws',
);

// A blank name is still a hard error (proves the theme fix did not blanket-soften).
assert.throws(
  () => validateShowsStrict([{ name: '', personaId: 'p_host' }], personas, allowed),
  /name must be 1-60 chars/,
  'invalid name still throws',
);

console.log('show-theme-id: all assertions passed');
