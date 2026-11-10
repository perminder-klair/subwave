import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import * as observatory from '../../web/components/observatory/data.js';
import type { RawTrack } from '../../web/components/observatory/data.js';

function rawTrack(id: string, genre: string, genres: string[]): RawTrack {
  return {
    id,
    title: `Track ${id}`,
    artist: 'Artist',
    album: 'Album',
    year: 2026,
    genre,
    genres,
    durationSec: 180,
    moods: ['driving'],
    energy: 'high',
    source: 'manual',
    confidence: 1,
    bpm: 128,
    musicalKey: '8A',
    analysisConfidence: 1,
    loudnessLufs: -12,
    paceMean: 0.8,
    vocal: 'vocal',
    mapX: null,
    mapY: null,
  };
}

test('layout and search retain every genre tag on a track', () => {
  const rows = [
    rawTrack('rock', 'Rock', ['Rock']),
    rawTrack('punk', 'Punk', ['Punk']),
    rawTrack('bridge', 'Rock', ['Rock', 'Fusion']),
  ];
  const laid = observatory.layoutTracks(rows);
  const bridge = laid.tracks.find((track) => track.id === 'bridge')!;

  assert.ok(laid.genres.includes('Fusion'), 'secondary genre gets its own scene');
  assert.ok(laid.centers.Fusion, 'secondary genre gets a fallback cluster centre');
  assert.match(bridge.searchText, /fusion/, 'secondary genre is searchable');

  const scalarOnly = observatory.layoutTracks(rows.map((track) => (
    track.id === 'bridge' ? { ...track, genres: ['Rock'] } : track
  ))).tracks.find((track) => track.id === 'bridge')!;
  assert.notDeepEqual(
    { x: bridge.x, y: bridge.y },
    { x: scalarOnly.x, y: scalarOnly.y },
    'secondary genres influence fallback placement',
  );
});

test('Observatory filters match any genre tag', () => {
  const laid = observatory.layoutTracks([
    rawTrack('bridge', 'Rock', ['Rock', 'Fusion']),
  ]);
  assert.equal(observatory.matchesObservatoryTrack(laid.tracks[0]!, {
    query: 'fusion',
    energy: new Set(),
    moods: new Set(),
    genres: new Set(['Fusion']),
    sources: new Set(),
    analysedOnly: false,
  }), true);
});

test('Observatory bulk and dossier APIs return the full genres array', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'subwave-observatory-genres-'));
  process.env.STATE_DIR = stateDir;

  const db = await import('../src/music/library-db.js');
  const library = await import('../src/music/library.js');
  const { router } = await import('../src/routes/library.js');
  let server: Server | null = null;

  try {
    await db.open({ embeddingDim: 768 });
    db.upsertTrackMeta('multi', {
      title: 'Signal Bridge',
      artist: 'The Arrays',
      album: 'Many Tags',
      year: 2026,
      genres: ['Rock', 'Fusion'],
      duration: 180,
    });
    db.upsertTrackTags('multi', {
      moods: ['driving'],
      energy: 'high',
      source: 'manual',
      confidence: 1,
    });

    const app = express();
    app.use(router);
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const bulk = await fetch(`http://127.0.0.1:${port}/library/observatory`);
    assert.equal(bulk.status, 200);
    const bulkBody = await bulk.json() as { tracks: Array<{ id: string; genres?: string[] }> };
    assert.deepEqual(bulkBody.tracks.find((track) => track.id === 'multi')?.genres, ['Rock', 'Fusion']);

    const detail = await fetch(`http://127.0.0.1:${port}/library/observatory/track/multi`);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as { track: { genres?: string[] } };
    assert.deepEqual(detailBody.track.genres, ['Rock', 'Fusion']);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    library.shutdown();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
