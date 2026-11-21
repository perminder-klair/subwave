// Run: npm test -- library-counts-share.
import assert from 'node:assert/strict';
import test from 'node:test';
import { share } from './LibraryCounts';

test('a share rounds down, so 100.0 % means every one', () => {
  // The station's own case: 74,628 can air, a few dozen not yet DJ-ready.
  assert.equal(share(74_600, 74_628), '99.9 %');
  assert.equal(share(74_627, 74_628), '99.9 %');
  assert.equal(share(74_628, 74_628), '100.0 %');
  assert.equal(share(7_083, 74_628), '9.4 %');
  assert.equal(share(1, 3), '33.3 %');
  assert.equal(share(2, 3), '66.6 %');
  assert.equal(share(0, 10), '0.0 %');
  assert.equal(share(5, 0), '—');
});
