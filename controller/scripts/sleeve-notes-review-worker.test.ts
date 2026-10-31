import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResearchCandidate, Researcher } from '../src/sleeve-notes/researcher.js';
const root = createTempDir(join(tmpdir(), 'subwave-selective-review-'));
process.env.STATE_DIR = root;
const settings = await import('../src/settings.js');
const { open, close } = await import('../src/sleeve-notes/db.js');
const { ResearchWorker } = await import('../src/sleeve-notes/research-worker.js');
await settings.load(); await settings.update({ djBehaviour: { extendedSleeveNotes: true } });
const db = open();
let number = 0;
const makeJob = (candidates: ResearchCandidate[]) => {
  const id = `fixture-${++number}`; const now = new Date().toISOString();
  db.prepare(`INSERT INTO sleeve_releases (id,title,musicbrainz_release_group_id,created_at,updated_at) VALUES (?, 'Bright Days', ?, ?, ?)`).run(id, id, now, now);
  db.prepare(`INSERT INTO sleeve_recordings (id,title,match_state,created_at,updated_at) VALUES (?, 'Song', 'matched', ?, ?)`).run(id, now, now);
  db.prepare(`INSERT INTO sleeve_recording_releases (recording_id,release_id,is_canonical_home) VALUES (?, ?, 1)`).run(id, id);
  db.prepare(`INSERT INTO sleeve_local_attachments (local_track_id,recording_id,title,match_state,first_encountered_at,last_encountered_at,updated_at) VALUES (?, ?, 'Song', 'matched', ?, ?, ?)`).run(id, id, now, now, now);
  db.prepare(`INSERT INTO sleeve_encounters (id,local_track_id,source,encountered_at) VALUES (?, ?, 'played', ?)`).run(id, id, now);
  db.prepare(`INSERT INTO sleeve_source_documents (id,entity_type,entity_id,provider,source_url,content_hash,content_kind,content,attribution,retrieved_at) VALUES (?, 'release-group', ?, 'genius', 'https://example.test', ?, 'bounded-text', ?, 'Genius', ?)`).run(id, id, id, candidates.map((c) => c.evidence).join('\n'), now);
  db.prepare(`INSERT INTO sleeve_research_jobs (id,provider,subject_type,subject_id,capability,state,created_at,updated_at) VALUES (?, 'researcher', 'release', ?, 'extract-genius-album', 'queued', ?, ?)`).run(id, id, now, now);
  return id;
};
const fact = (place: string): ResearchCandidate => ({ category: 'release-stories', topic: `recording ${place}`, wording: `Bright Days was recorded in a converted ${place}.`, evidence: `Bright Days was recorded in a converted ${place}.` });
const run = async (worker: InstanceType<typeof ResearchWorker>) => {
  db.prepare("UPDATE sleeve_research_pacing SET next_pair_at = '2000-01-01T00:00:00Z' WHERE id=1").run();
  db.prepare("UPDATE sleeve_research_jobs SET run_after = NULL WHERE state = 'retry-at'").run();
  return worker.runOnce();
};
const count = (table: string, id: string) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE source_document_id = ?`).get(id) as { count: number }).count;
test('a missing verdict retries the same cursor and creates no partial facts or Review entries', async () => {
  const candidates = [fact('church'), fact('barn')]; const id = makeJob(candidates);
  const researcher: Researcher = { extract: async () => candidates, reviewForAirtime: async () => [{ claimId: 'C001', decision: 'ready', reason: 'Useful recording story' }] };
  assert.equal(await run(new ResearchWorker({ isQuiet: () => true }, researcher)), true);
  const progress = db.prepare('SELECT check_cursor AS cursor FROM sleeve_research_progress WHERE job_id = ?').get(id) as { cursor: number };
  assert.equal(progress.cursor, 0);
  assert.equal(count('sleeve_claims', id), 0); assert.equal(count('sleeve_moderation_candidates', id), 0);
  assert.equal((db.prepare('SELECT state FROM sleeve_research_jobs WHERE id = ?').get(id) as { state: string }).state, 'retry-at');
  db.prepare("UPDATE sleeve_research_jobs SET state='cancelled' WHERE id=?").run(id);
});
test('the production album pipeline retains scoped facts instead of sending them to Review', async () => {
  const candidates = [fact('church')]; const id = makeJob(candidates);
  const researcher: Researcher = { extract: async () => candidates, reviewForAirtime: async () => [{ claimId: 'C001', decision: 'matching-release-only', releaseTitle: 'Bright Days', reason: 'Needs the matching album' }] };
  assert.equal(await run(new ResearchWorker({ isQuiet: () => true }, researcher)), true);
  assert.equal(count('sleeve_claims', id), 1); assert.equal(count('sleeve_moderation_candidates', id), 0);
});
test('the production queue admits at most two nominated repairs, and routine discards do not fill it', async () => {
  const candidates = [fact('church'), fact('barn'), fact('warehouse')]; const id = makeJob(candidates);
  const researcher: Researcher = { extract: async () => candidates, reviewForAirtime: async (_job, batch) => batch.map((candidate, index) => ({ claimId: `C${String(index + 1).padStart(3, '0')}`, decision: 'bin', reviewIssue: 'wording', reason: `The location is supported; clarify the album subject in: ${candidate.wording}` })) };
  const worker = new ResearchWorker({ isQuiet: () => true }, researcher);
  await run(worker); await run(worker);
  assert.equal(count('sleeve_moderation_candidates', id), 2);
  const discarded = makeJob([fact('studio')]);
  const discardWorker = new ResearchWorker({ isQuiet: () => true }, { extract: async () => [fact('studio')], reviewForAirtime: async () => [{ claimId: 'C001', decision: 'bin', reason: 'Not interesting enough for a link' }] });
  await run(discardWorker); assert.equal(count('sleeve_moderation_candidates', discarded), 0);
});
test.after(async () => { close(); await removeTempDir(root); });
