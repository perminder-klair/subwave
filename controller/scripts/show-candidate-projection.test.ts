import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-show-candidates-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const { trackEraYear, trackInstrumental } = await import('../src/music/show-filter.js');
const { candidateCoverage } = await import('../src/music/show-candidates.js');

await db.open({ embeddingDim: 768 });

after(() => {
  db.close();
  rmSync(stateDir, { recursive: true, force: true });
});

test('candidate projection preserves vocal analysis as unknown, instrumental, or vocal', () => {
  const insert = db.requireDb().prepare(
    `INSERT INTO tracks (id, title, artist, audio_moods, energy, vocal_ranges_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insert.run('unknown', 'Unknown', 'A', JSON.stringify(['calm']), null, null);
  insert.run('instrumental', 'Instrumental', 'B', null, null, '[]');
  insert.run('vocal', 'Vocal', 'C', null, 'medium', JSON.stringify([{ startMs: 1_000, endMs: 9_000 }]));

  const rows = new Map(db.candidateFilterTracks().map((row) => [row.id, row]));
  assert.equal(trackInstrumental(rows.get('unknown')), null);
  assert.equal(trackInstrumental(rows.get('instrumental')), true);
  assert.equal(trackInstrumental(rows.get('vocal')), false);
  assert.deepEqual(candidateCoverage([...rows.values()]), { mood: true, energy: true, vocal: true });
});

test('candidate projection carries the derived era-trust verdict', () => {
  db.requireDb().prepare(
    `INSERT INTO tracks (id, title, artist, year, is_compilation, era_untrusted)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('suspect-anthology', 'Old Recording', 'Someone', 2012, 0, 1);

  const row = db.candidateFilterTracks().find((candidate) => candidate.id === 'suspect-anthology');
  assert.equal(trackEraYear(row), null,
    'a derived anthology must not regain its reissue year in the show diagnostic');
});
