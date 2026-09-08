// The commit-then-skip policy (broadcast/skip-policy.ts): an operator skip
// airs the COMMITTED pick, not a random auto.m3u fill (#1300 bug 6). Under
// pair-aware drain the held pick is absent from dj_queue for most of a track,
// so the route commits, waits for a ready request, then skips.

import assert from 'node:assert/strict';
import {
  parseDjQueueStatus, skipPrepAction, commitSatisfied,
  SKIP_COMMIT_WAIT_MS, SKIP_POLL_INTERVAL_MS, UNKNOWN_STATUS_GRACE_MS,
} from '../src/broadcast/skip-policy.js';

// The three words dj_queue_status can answer; telnet responses carry \r\n.
assert.equal(parseDjQueueStatus('ready'), 'ready', 'ready parses');
assert.equal(parseDjQueueStatus('  ready\r\n'), 'ready', 'trims telnet whitespace');
assert.equal(parseDjQueueStatus('resolving'), 'resolving', 'resolving parses');
assert.equal(parseDjQueueStatus('empty'), 'empty', 'empty parses');

// An older radio.liq answers with an error line: upgrade skew, not a state.
assert.equal(
  parseDjQueueStatus('ERROR: unknown command, type "help" to get the list of commands.'),
  'unknown',
  'unknown command → unknown',
);
assert.equal(parseDjQueueStatus(''), 'unknown', 'empty response → unknown');
assert.equal(parseDjQueueStatus(null), 'unknown', 'null → unknown');
assert.equal(parseDjQueueStatus(undefined), 'unknown', 'undefined → unknown');
// Never guess on a garbled response.
assert.equal(parseDjQueueStatus('READY set go'), 'unknown', 'garbage → unknown');

// Nothing queued: the bare skip, since auto.m3u is the honest next.
assert.equal(skipPrepAction(0), 'skip-now', 'empty queue → skip now');
// Anything queued: commit before skipping. Covers the held-unsent pick and
// the sent-but-still-resolving race.
assert.equal(skipPrepAction(1), 'commit', 'one queued → commit first');
assert.equal(skipPrepAction(3), 'commit', 'several queued → commit first');

// The contract is about the HEAD of upcoming: until it reaches dj_queue
// nothing is committed, whatever the probe says.
assert.equal(
  commitSatisfied({ headSent: false, queueStatus: 'ready', sinceHeadSentMs: 0 }),
  false,
  'head unsent → not satisfied even if the probe says ready',
);

// Sent plus a resolved request waiting: the fallback will pick dj_queue.
assert.equal(
  commitSatisfied({ headSent: true, queueStatus: 'ready', sinceHeadSentMs: 0 }),
  true,
  'sent + ready → satisfied',
);

// Still resolving: keep waiting; the outer timeout bounds it.
assert.equal(
  commitSatisfied({ headSent: true, queueStatus: 'resolving', sinceHeadSentMs: 10_000 }),
  false,
  'resolving → keep waiting',
);
assert.equal(
  commitSatisfied({ headSent: true, queueStatus: 'empty', sinceHeadSentMs: 10_000 }),
  false,
  'empty after send → keep waiting (poll race, boundary prefetch, or a failed resolve)',
);

// Upgrade skew, no probe: proceed on a fixed grace after the send rather than
// never skipping or skipping at once.
assert.equal(
  commitSatisfied({ headSent: true, queueStatus: 'unknown', sinceHeadSentMs: 0 }),
  false,
  'unknown status → wait out the grace first',
);
assert.equal(
  commitSatisfied({ headSent: true, queueStatus: 'unknown', sinceHeadSentMs: UNKNOWN_STATUS_GRACE_MS }),
  true,
  'unknown status → satisfied after the grace',
);

// The wait must cover a drain (writeHandoff waits up to 5s), the 1s queue poll
// and a subhttp fetch, while staying a bounded UI action.
assert.ok(SKIP_COMMIT_WAIT_MS >= 15_000, 'wait covers drain + poll + fetch');
assert.ok(SKIP_COMMIT_WAIT_MS <= 30_000, 'wait stays a bounded UI action');
assert.ok(SKIP_POLL_INTERVAL_MS <= 1_000, 'poll at least as often as the queue poll');
assert.ok(
  UNKNOWN_STATUS_GRACE_MS + 2 * SKIP_POLL_INTERVAL_MS < SKIP_COMMIT_WAIT_MS,
  'grace fits inside the wait with polls to spare',
);

console.log('skip-policy: all assertions passed');
