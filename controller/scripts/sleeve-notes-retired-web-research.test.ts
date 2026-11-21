import {createTempDir, removeTempDir} from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = createTempDir(join(tmpdir(), 'subwave-retired-web-'));
process.env.STATE_DIR = root;
const { migrate, close } = await import('../src/sleeve-notes/db.js');
const { loadExtendedSleeveNoteCandidatesInDatabase } = await import('../src/sleeve-notes/link-selection.js');
const { router } = await import('../src/routes/sleeve-notes.js');
const now = new Date().toISOString();
function fixture() {
  const db = new Database(':memory:'); migrate(db);
  db.prepare(`INSERT INTO sleeve_artists(id,name,musicbrainz_id,created_at,updated_at) VALUES ('artist','Band','artist',?,?)`).run(now, now);
  db.prepare(`INSERT INTO sleeve_recordings(id,title,artist_id,match_state,created_at,updated_at) VALUES ('recording','Song','artist','matched',?,?)`).run(now, now);
  db.prepare(`INSERT INTO sleeve_local_attachments(local_track_id,title,artist,recording_id,match_state,first_encountered_at,last_encountered_at,updated_at)
    VALUES ('local','Song','Band','recording','matched',?,?,?)`).run(now, now, now);
  for (const provider of ['web-operator', 'wikipedia']) {
    db.prepare(`INSERT INTO sleeve_source_documents(id,entity_type,entity_id,provider,source_url,content_hash,content_kind,content,attribution,retrieved_at)
      VALUES (?,'artist','artist',?,'https://example.test/story','hash','bounded-text','Band recorded in a barn.','Article',?)`).run(provider, provider, now);
    db.prepare(`INSERT INTO sleeve_claims(id,entity_type,entity_id,category,topic,wording,source_document_id,evidence,enabled,created_at,updated_at)
      VALUES (?,'artist','artist','artist-stories',?,'Band recorded in a barn.',?,'Band recorded in a barn.',1,?,?)`).run(provider, provider, provider, now, now);
  }
  return db;
}


test('legacy web sources cannot qualify for Sparks even if a saved claim is enabled', () => {
  const db = fixture();
  const candidates = loadExtendedSleeveNoteCandidatesInDatabase(db, 'local', 'Band');
  assert.ok(candidates.some(candidate => candidate.claimId === 'wikipedia'));
  assert.ok(!candidates.some(candidate => candidate.claimId === 'web-operator'));
  db.close();
});

test('removed web research endpoints accept no reads or new requests while the feature is enabled', async () => {
  const settings = await import('../src/settings.js');
  await settings.load();
  await settings.update({djBehaviour:{extendedSleeveNotes:true}});
  const app = express(); app.use(express.json(), router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
    const url = `http://127.0.0.1:${address.port}/sleeve-notes/operator-research`;
    assert.equal((await fetch(url)).status, 404);
    assert.equal((await fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status, 404);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test.after(async () => { close(); await removeTempDir(root); });
