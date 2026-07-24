// Unit tests for the playlist builder's async job store
// (music/playlist-jobs.ts): lifecycle (create → complete/fail → get), the
// lazy TTL sweep, and the concurrent-run cap. The store is what lets
// /playlists/generate/jobs outlive Cloudflare's ~100s proxy timeout, so the
// expiry/cap behaviour here is the contract the panel's poller relies on.
// Run: `tsx scripts/playlist-jobs.test.ts`.
//
// node:assert-via-tsx style, matching scripts/programme.test.ts.

import assert from 'node:assert/strict';
import * as jobs from '../src/music/playlist-jobs.js';
import type { GenerateResult } from '../src/music/playlist-gen.js';

const RESULT: GenerateResult = {
  tracks: [],
  reasons: [],
  usedFallback: false,
  poolSize: 0,
} as unknown as GenerateResult;

const T0 = 1_000_000;

// ── lifecycle ────────────────────────────────────────────────────────────────

// create → running; complete → done with the result readable via get.
{
  jobs._clear();
  const job = jobs.create(T0);
  assert.ok(job, 'create returns a job');
  assert.equal(job!.status, 'running');
  jobs.complete(job!.id, RESULT, T0 + 1000);
  const seen = jobs.get(job!.id, T0 + 2000);
  assert.equal(seen?.status, 'done');
  assert.equal(seen?.result, RESULT);
}

// fail → error with the message readable.
{
  jobs._clear();
  const job = jobs.create(T0)!;
  jobs.fail(job.id, 'model unreachable', T0 + 1000);
  const seen = jobs.get(job.id, T0 + 2000);
  assert.equal(seen?.status, 'error');
  assert.equal(seen?.error, 'model unreachable');
}

// complete/fail on an already-landed job is a no-op (first landing wins).
{
  jobs._clear();
  const job = jobs.create(T0)!;
  jobs.complete(job.id, RESULT, T0 + 1000);
  jobs.fail(job.id, 'late failure', T0 + 2000);
  assert.equal(jobs.get(job.id, T0 + 3000)?.status, 'done', 'fail after complete ignored');
}

// ── sweep ────────────────────────────────────────────────────────────────────

// A finished job survives within RESULT_TTL_MS and expires after it.
{
  jobs._clear();
  const job = jobs.create(T0)!;
  jobs.complete(job.id, RESULT, T0);
  assert.ok(jobs.get(job.id, T0 + jobs.RESULT_TTL_MS - 1), 'claimable inside the TTL');
  assert.equal(jobs.get(job.id, T0 + jobs.RESULT_TTL_MS + 1), undefined, 'expired past the TTL');
}

// A wedged running job is dropped past MAX_AGE_MS (it must not hold a slot).
{
  jobs._clear();
  const job = jobs.create(T0)!;
  assert.ok(jobs.get(job.id, T0 + jobs.MAX_AGE_MS - 1), 'running job survives inside MAX_AGE');
  assert.equal(jobs.get(job.id, T0 + jobs.MAX_AGE_MS + 1), undefined, 'wedged job swept past MAX_AGE');
}

// ── concurrent-run cap ───────────────────────────────────────────────────────

// The MAX_RUNNING'th+1 create is refused; a landed job frees its slot.
{
  jobs._clear();
  const running = Array.from({ length: jobs.MAX_RUNNING }, () => jobs.create(T0)!);
  assert.equal(running.length, jobs.MAX_RUNNING);
  assert.equal(jobs.create(T0), null, 'cap refuses another concurrent run');
  jobs.complete(running[0]!.id, RESULT, T0 + 1000);
  assert.ok(jobs.create(T0 + 2000), 'a landed job frees its slot');
}

console.log('playlist-jobs tests passed');
