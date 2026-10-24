import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = createTempDir(join(tmpdir(), 'subwave-spark-prompt-'));
process.env.STATE_DIR = root;
const settings = await import('../src/settings.js');
const store = await import('../src/settings/store.js');
const { open, close } = await import('../src/sleeve-notes/db.js');
const { primaryLeg } = await import('../src/llm/internal/provider/legs.js');
const { generateLink, linkPrompt } = await import('../src/llm/internal/prompts/scripts.js');
const { inspectExtendedSleeveNote,recordExtendedSleeveNoteTtsRequest } = await import('../src/sleeve-notes/link-selection.js');
const { connectionDirectionGuidance } = await import('../src/sleeve-notes/library-connections.js');
test.after(async () => { close(); await removeTempDir(root); });

test('production link generation honors Spark suppression and a short vocal runway', async (t) => {
  const defaults = settings.getDefaults();
  store.setCache({ ...defaults, djBehaviour: { ...defaults.djBehaviour, extendedSleeveNotes: true },
    llm: { ...defaults.llm, provider: 'openai', model: 'spark-test',
      fallback: { ...defaults.llm.fallback, enabled: false } } });
  const db = open();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sleeve_artists (id, name, musicbrainz_id, created_at, updated_at)
    VALUES ('artist', 'Band', 'artist', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO sleeve_source_documents (id, entity_type, entity_id, provider, source_url,
    content_hash, content_kind, content, attribution, retrieved_at)
    VALUES ('source', 'artist', 'artist', 'wikipedia', 'https://wiki.test', 'wiki', 'bounded-text',
      'The band recorded in a converted barn.', 'Wikipedia', ?)`).run(now);
  db.prepare(`INSERT INTO sleeve_claims (id, entity_type, entity_id, category, topic, wording,
    source_document_id, evidence, created_at, updated_at)
    VALUES ('claim', 'artist', 'artist', 'artist-stories', 'barn', 'The band recorded in a converted barn.',
      'source', 'The band recorded in a converted barn.', ?, ?)`).run(now, now);
  const prompts: string[] = [];
  let reply = { speech: 'This is Band with Song.', sparkDecision: 'pass', reason: 'The fact does not fit this short introduction.' };
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network call'); });
  const leg = primaryLeg();
  for (const model of new Set([leg.model, leg.noThinkModel])) {
    t.mock.method(model, 'doGenerate', async (options: unknown) => {
      prompts.push(JSON.stringify(options));
      return { content: [{ type: 'text', text: prompts.at(-1)!.includes('Story Spark — optional research material')
          ? JSON.stringify(reply)
          : 'This is Band with Song.' }],
        finishReason: { unified: 'stop', raw: 'stop' }, warnings: [],
        usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 4, text: 4, reasoning: 0 } } };
    });
  }
  const args = { current: { id: 'local', artist: 'Band', title: 'Song', vocalRanges: [{ startMs: 8_000, endMs: 9_000 }] },
    persona: { name: 'DJ', linkStyle: 'conversational' } };
  assert.equal(await generateLink(args), 'This is Band with Song.');
  assert.match(prompts.at(-1)!, /Story Spark — optional research material/);
  assert.match(prompts.at(-1)!, /natural radio introduction/);
  assert.match(prompts.at(-1)!, /Reserve room for the supplied artist and track title/);
  assert.doesNotMatch(prompts.at(-1)!, /opening sentence|before greetings or atmosphere/);
  await generateLink({ ...args, suppressExtendedSleeveNote: true });
  assert.doesNotMatch(prompts.at(-1)!, /Story Spark — optional research material/);
  await generateLink({ ...args, current: { ...args.current, vocalRanges: [{ startMs: 500, endMs: 1_000 }] } });
  assert.doesNotMatch(prompts.at(-1)!, /Story Spark — optional research material/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sleeve_claim_uses').get() as { n: number }).n, 1);
  const first = db.prepare('SELECT final_text, dj_context_pass_reason, dj_quality_rejection_reason FROM sleeve_claim_uses').get() as Record<string, string | null>;
  assert.equal(first.final_text, 'This is Band with Song.');
  assert.equal(first.dj_context_pass_reason, reply.reason);
  assert.equal(first.dj_quality_rejection_reason, null, 'a timing pass is not a quality rejection');
  assert.equal(prompts.length, 3, 'each link uses one generation, with no editorial review call');

  const release = () => db.prepare('UPDATE sleeve_claim_uses SET released_at = ? WHERE aired_at IS NULL').run(now);
  release();
  reply = { speech: 'This is Band with Song.', sparkDecision: 'quality-concern', reason: 'The supplied wording does not identify which band it concerns.' };
  assert.equal(await generateLink(args), 'This is Band with Song.');
  assert.ok(db.prepare('SELECT 1 FROM sleeve_claim_uses WHERE dj_quality_rejection_reason = ?').get(reply.reason));
  release();
  reply = { speech: 'This is Band with Song. They recorded in a converted barn.', sparkDecision: 'pass', reason: 'Contradictory private verdict.' };
  assert.equal(await generateLink(args), reply.speech);
  const expressed = db.prepare('SELECT detection_status, dj_context_pass_reason FROM sleeve_claim_uses WHERE final_text = ?').get(reply.speech) as Record<string, string | null>;
  assert.equal(expressed.detection_status, 'detected');
  assert.equal(expressed.dj_context_pass_reason, null, 'a private pass never overrides a clear spoken claim');
  release();
  reply = { speech: '', sparkDecision: 'pass', reason: 'No complete spoken thought fits.' };
  assert.equal(await generateLink(args), '');
  const silent = db.prepare('SELECT released_at, dj_context_pass_reason FROM sleeve_claim_uses WHERE final_text = ?').get('') as Record<string, string | null>;
  assert.ok(silent.released_at);
  assert.equal(silent.dj_context_pass_reason, reply.reason);
  assert.equal(prompts.length, 6);

  release();
  const french='Ils ont enregistré cet album dans une grange aménagée.';
  reply={speech:french,sparkDecision:'use',reason:'A supported recording story'};
  const before=prompts.length;
  assert.equal(await generateLink({...args,persona:{...args.persona,language:'French'}}),french);
  assert.equal(prompts.length,before+1,'translated speech also uses one generation without review');
  const translated=db.prepare('SELECT id FROM sleeve_claim_uses WHERE final_text=?').get(french) as {id:string};
  recordExtendedSleeveNoteTtsRequest(translated.id,french);
  release();
  db.prepare("UPDATE sleeve_claims SET wording='Band formed in Cardiff in 1993.',evidence='Band formed in Cardiff in 1993.' WHERE id='claim'").run();
  reply={speech:'Band formed in Cardiff in 1994.',sparkDecision:'use',reason:'A story'};
  assert.equal(await generateLink(args),reply.speech,'wording is governed by station prompts, not a factual veto');


});

test('connection prompt states the direction and refuses unsupported sample details or playback promises', () => {
  const prompt = linkPrompt({ current: { title: 'Song', artist: 'Band' }, extendedSleeveNote: {
    wording: 'Related Song samples Song by Band.', category: 'musical-connections', attribution: 'Genius',
    connection: { type: 'sampled_in' }} });
  assert.match(prompt, /The linked song samples the current track/);
  assert.match(prompt, /Do not infer which musical or lyrical passage/);
  assert.match(prompt, /Do not claim the linked track has played or will play/);
  assert.match(connectionDirectionGuidance('covered_by'), /linked song is a cover version of the current/);
  assert.match(connectionDirectionGuidance('cover_of'), /current track is a cover version of the linked/);
});

test('persisted passes rotate ranked stories even after a released reservation expires', () => {
  const db = open();
  db.prepare('DELETE FROM sleeve_claim_uses').run();
  db.prepare('UPDATE sleeve_claims SET extraction_rank = 1 WHERE id = ?').run('claim');
  const nowMs = Date.now();
  const old = new Date(nowMs - 3 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO sleeve_claims (id, entity_type, entity_id, category, topic, wording,
    source_document_id, evidence, extraction_rank, created_at, updated_at)
    VALUES ('second', 'artist', 'artist', 'artist-stories', 'other', 'The band chose a converted barn.',
      'source', 'The band chose a converted barn.', 2, ?, ?)`).run(old, old);
  const current = { id: 'local', artist: 'Band' };
  assert.equal(inspectExtendedSleeveNote(current, nowMs).note?.claimId, 'claim');
  db.prepare(`INSERT INTO sleeve_claim_uses (id, claim_id, entity_type, entity_id, category, topic,
    local_track_id, consumer, supplied_at, final_text, offered_wording, detection_status,
    released_at, dj_context_pass_reason)
    VALUES ('pass', 'claim', 'artist', 'artist', 'artist-stories', 'barn', 'local', 'dj-link', ?,
      'This is Band with Song.', 'The band recorded in a converted barn.', 'not-detected', ?,
      'The story does not fit the link.')`).run(old, old);
  close();
  assert.equal(inspectExtendedSleeveNote(current, nowMs).note?.claimId, 'second', 'pass survives reopening the store');
  const reopened = open();
  reopened.prepare('UPDATE sleeve_claim_uses SET dj_context_pass_reason = NULL, aired_at = ? WHERE id = ?')
    .run(old, 'pass');
  assert.equal(inspectExtendedSleeveNote(current, nowMs).note?.claimId, 'second', 'an aired omission also spends a turn');
  reopened.prepare('UPDATE sleeve_claim_uses SET aired_at = NULL WHERE id = ?').run('pass');
  assert.equal(inspectExtendedSleeveNote(current, nowMs).note?.claimId, 'claim', 'a cancelled offer without a pass does not');
});
