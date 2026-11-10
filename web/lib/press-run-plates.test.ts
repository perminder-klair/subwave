// The landing's Press Run shows every skin exactly once. The plate list is
// plain data, copied out of the registry so the capture script can import it
// from node without next/dynamic, so this pins the copy to the registry: a new
// skin without a plate, a plate for a retired skin, or a renamed skin fails
// here rather than on the landing page.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SKINS } from '@/components/skins';
import { PRESS_RUN_PLATES } from './press-run-plates';

test('every registered skin has exactly one plate', () => {
  assert.deepEqual(
    PRESS_RUN_PLATES.map(p => p.skinId).sort(),
    SKINS.map(s => s.id).sort(),
  );
});

test('every plate shows a different theme', () => {
  const themes = PRESS_RUN_PLATES.map(p => p.themeId);
  assert.equal(new Set(themes).size, themes.length);
});

test("a plate's skin name and description are the registry's, verbatim", () => {
  for (const plate of PRESS_RUN_PLATES) {
    const skin = SKINS.find(s => s.id === plate.skinId);
    assert.equal(plate.skinName, skin?.name, plate.id);
    assert.equal(plate.skinDescription, skin?.description, plate.id);
  }
});
