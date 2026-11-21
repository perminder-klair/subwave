import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = createTempDir(join(tmpdir(), 'subwave-genius-queue-'));
process.env.STATE_DIR = root;
const { open, close } = await import('../src/sleeve-notes/db.js');
const { geniusQueueReadout, geniusRequestAllowance, reserveGeniusProviderRequest } = await import('../src/sleeve-notes/research-repository.js');
after(async () => { close(); await removeTempDir(root); });
const now = new Date('2026-10-18T13:00:00.000Z');

test('queue readout separates due work from retry delays and reports the age of the oldest due job', () => {
  const db = open();
  const insert = db.prepare(`INSERT INTO sleeve_research_jobs(id,provider,subject_type,subject_id,capability,state,
    run_after,created_at,updated_at) VALUES (?,'genius','recording',?,?,?,?,'2026-10-18T12:00:00.000Z',?)`);
  insert.run('track', 'track', 'connections', 'queued', null, now.toISOString());
  insert.run('album', 'album', 'album-biography', 'retry-at', '2026-10-18T13:10:00.000Z', now.toISOString());
  insert.run('sample', 'sample', 'sample-traversal', 'queued', null, now.toISOString());
  insert.run('expansion', 'expansion', 'expand-samples', 'queued', null, now.toISOString());
  insert.run('running', 'running', 'connections', 'running', null, now.toISOString());
  const countBefore = db.prepare('SELECT count(*) AS n FROM sleeve_provider_requests').get();
  const result = geniusQueueReadout(now);
  assert.deepEqual(result.pending, { encountered: 1, albums: 1, samples: 2 });
  assert.equal(result.ready, 3); assert.equal(result.readyRequests, 2);
  assert.equal(result.deferred, 1); assert.equal(result.running, 1);
  assert.equal(result.oldestReadyAgeSeconds, 3600);
  assert.deepEqual(db.prepare('SELECT count(*) AS n FROM sleeve_provider_requests').get(), countBefore);
});

test('readout and reservation agree on rolling allowance and exponential backoff without spending requests on reads', () => {
  const db = open();
  for (let i = 0; i < 6; i++) assert.ok('requestId' in reserveGeniusProviderRequest(new Date(now.getTime() - 55_000 + i * 10_000)));
  const allowance = geniusRequestAllowance(db, now);
  assert.equal(allowance.minuteRequests, 6); assert.equal(allowance.dayRequests, 6);
  assert.equal(allowance.waitReason, 'allowance');
  assert.deepEqual(reserveGeniusProviderRequest(now), { waitMs: allowance.waitMs });
  db.prepare(`UPDATE sleeve_provider_requests SET outcome='rate-limited',status_code=429 WHERE requested_at>=?`)
    .run(new Date(now.getTime() - 25_000).toISOString());
  const backoff = geniusRequestAllowance(db, now);
  assert.equal(backoff.waitReason, 'backoff');
  assert.equal(backoff.retryAt, '2026-10-18T13:03:55.000Z');
  assert.deepEqual(reserveGeniusProviderRequest(now), { waitMs: backoff.waitMs });
  const tomorrow = geniusRequestAllowance(db, new Date('2026-10-19T13:00:01Z'));
  assert.equal(tomorrow.minuteRequests, 0); assert.equal(tomorrow.dayRequests, 0);
  assert.equal(tomorrow.waitReason, null);
});

test('daily usage is counted without imposing the former daily cap', () => {
  const db = open();
  db.prepare('DELETE FROM sleeve_provider_requests').run();
  const insert = db.prepare(`INSERT INTO sleeve_provider_requests(id,provider,capability,requested_at,outcome,status_code)
    VALUES (?,'genius','connections','2026-10-18T12:00:00.000Z','ready',200)`);
  db.transaction(() => { for (let i = 0; i < 4320; i++) insert.run(`daily-${i}`); })();
  const allowance = geniusRequestAllowance(db, now);
  assert.equal(allowance.minuteRequests, 0); assert.equal(allowance.dayRequests, 4320);
  assert.equal(allowance.waitReason, null); assert.equal(allowance.dayLimit, null);
  assert.equal(allowance.retryAt, null);
  assert.ok('requestId' in reserveGeniusProviderRequest(now));
});


test('requests are spaced by ten seconds even when the rolling minute has spare capacity', () => {
  const db = open();
  db.prepare('DELETE FROM sleeve_provider_requests').run();
  assert.ok('requestId' in reserveGeniusProviderRequest(now));
  assert.deepEqual(reserveGeniusProviderRequest(new Date(now.getTime()+1_000)), { waitMs: 9_000 });
  assert.ok('requestId' in reserveGeniusProviderRequest(new Date(now.getTime()+10_000)));
  assert.equal(geniusRequestAllowance(db,new Date(now.getTime()+10_000)).minuteRequests,2);
});
