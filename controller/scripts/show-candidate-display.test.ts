import assert from 'node:assert/strict';
import { test } from 'node:test';

import { displayedMatchingTracks } from '../../web/components/admin/shows/candidate-diagnostic.js';

test('strict diagnostics display the effective playlist pool instead of library-wide matches', () => {
  const report = {
    strict: true,
    library: { indexed: 4, matchingFilters: 2, afterExclusions: 1, effective: 0 },
    playlist: { total: 2, matchingFilters: 1, afterExclusions: 0, effective: 0 },
    warnings: [],
  };

  assert.equal(displayedMatchingTracks(report), 0);
});

test('soft diagnostics keep the filter-fit count visible', () => {
  const report = {
    strict: false,
    library: { indexed: 4, matchingFilters: 2, afterExclusions: 2, effective: 4 },
    playlist: null,
    warnings: [],
  };

  assert.equal(displayedMatchingTracks(report), 2);
});
