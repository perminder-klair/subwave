import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrate, SCHEMA_VERSION } from '../src/sleeve-notes/db.js';
import {
  libraryArtistIdentity,
  reconcileProvisionalArtists,
  artistIsLocal,
} from '../src/sleeve-notes/artist-identity.js';
import { researchStoreExploreInDatabase } from '../src/sleeve-notes/research-repository.js';

function fixture() {
  const db = new Database(':memory:');
  migrate(db);
  db.prepare("INSERT INTO sleeve_connection_library_artists VALUES ('local','2Pac','2pac')").run();
  for (const id of ['a', 'b', 'canonical'])
    db.prepare(
      'INSERT INTO sleeve_artists(id,name,musicbrainz_id,created_at,updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, '2Pac', id === 'canonical' ? 'mbid' : null, 'now', 'now');
  for (const id of ['a', 'b']) {
    db.prepare(
      "INSERT INTO sleeve_recordings(id,title,artist_id,match_state,created_at,updated_at) VALUES (?, ?, ?, 'unmatched','now','now')",
    ).run(id, `Song ${id}`, id);
    db.prepare(
      'INSERT INTO sleeve_genius_traversal(song_id,recording_id,title_key,artist_key) VALUES (?,?,?,?)',
    ).run(id === 'a' ? '1' : '2', id, `song ${id}`, '2pac');
  }
  return db;
}
test('existing Genius children join the unambiguous canonical artist without changing recording ids', () => {
  const db = fixture();
  assert.equal(libraryArtistIdentity(db, '2Pac', 'later'), 'canonical');
  assert.deepEqual(db.prepare('SELECT id,artist_id FROM sleeve_recordings ORDER BY id').all(), [
    { id: 'a', artist_id: 'canonical' },
    { id: 'b', artist_id: 'canonical' },
  ]);
  assert.equal(artistIsLocal(db, 'canonical'), true);
  assert.equal(libraryArtistIdentity(db, 'The 2Pac', 'later'), 'canonical');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});
test('late canonical research repairs multiple provisional artists, but different canonical identities never merge', () => {
  const db = fixture();
  reconcileProvisionalArtists(db);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM sleeve_recordings WHERE artist_id='canonical'").get()!.n,
    2,
  );
  db.prepare(
    "INSERT INTO sleeve_artists(id,name,musicbrainz_id,created_at,updated_at) VALUES ('other','2Pac','different','now','now')",
  ).run();
  assert.equal(libraryArtistIdentity(db, '2Pac', 'later'), null);
  db.close();
});
test('artist-level work and decisions prevent automatic relocation of its recordings', () => {
  const db = fixture();
  db.prepare(
    "INSERT INTO sleeve_research_jobs(id,provider,subject_type,subject_id,capability,state,created_at,updated_at) VALUES ('job','wikipedia','artist','a','biography','queued','now','now')",
  ).run();
  libraryArtistIdentity(db, '2Pac', 'later');
  assert.equal(
    db.prepare("SELECT artist_id FROM sleeve_recordings WHERE id='a'").get()!.artist_id,
    'a',
  );
  db.close();
});
test('public v1 upgrades by adding indexes without resetting collected research', () => {
  const db = fixture();
  db.pragma('user_version=1');
  const before = db.prepare('SELECT * FROM sleeve_recordings').all();
  migrate(db);
  migrate(db);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.deepEqual(db.prepare('SELECT * FROM sleeve_recordings').all(), before);
  assert.equal(researchStoreExploreInDatabase(db, { search: '2Pac' }).total, 0);
  db.close();
});


test('Browse Library checks indexed recordings for each artist before searching their claims', () => {
  const db = fixture();
  const prepare = db.prepare.bind(db);
  let artistQuery = '';
  db.prepare = ((sql: string) => {
    if (sql.includes('FROM sleeve_artists artist_row')) artistQuery = sql;
    return prepare(sql);
  }) as typeof db.prepare;
  try {
    researchStoreExploreInDatabase(db, {});
    const plan = prepare(`EXPLAIN QUERY PLAN ${artistQuery}`).all('', '%%', '%%', '', '', 30, 0) as Array<{detail: string}>;
    assert.ok(plan.some(row => /SEARCH child_recording .*\(artist_id=\?\)/.test(row.detail)),
      'artist browse must look up that artist’s recordings, rather than repeatedly scanning every recording claim');
    assert.ok(plan.some(row => /SEARCH recording_claim .*\(entity_type=\? AND entity_id=\?\)/.test(row.detail)));
  } finally { db.close(); }
});
