import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardAnchor } from '../components/admin/ui';
import { ADVANCED_CARDS, SETTINGS_INDEX, type SectionId } from '../components/admin/settings/registry';

// An Advanced anchor that no searchable card carries is dead: a search result
// can never open the disclosure for it. 'next-track-picker' sat under the LLM
// section for a whole PR after its card moved to Music selection.
test('every Advanced anchor names a searchable card in its own section', () => {
  for (const [section, anchors] of Object.entries(ADVANCED_CARDS) as [SectionId, readonly string[]][]) {
    const cards = new Set(SETTINGS_INDEX.filter(e => e.section === section).map(e => cardAnchor(e.card)));
    for (const anchor of anchors) {
      assert.ok(cards.has(anchor), `${section}: Advanced anchor "${anchor}" has no SETTINGS_INDEX card`);
    }
  }
});
