import assert from 'node:assert/strict';
import { fmtClock } from '../web/lib/format.ts';

const t = Date.UTC(2026, 0, 1, 13, 5, 0);

assert.equal(fmtClock(t, 'UTC', 'en-GB'), '13:05:00');
assert.equal(fmtClock(t, 'UTC', 'en-US'), '1:05:00 PM');

console.log('format locale tests passed.');
